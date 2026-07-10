# Produk Ekspedisi — War Room Ekspedisi > Produk Ekspedisi

## Tujuan
Dashboard monitoring performa PRODUK ekspedisi (bukan per outlet secara
langsung) — MAT, jumlah bill, margin FP, pertumbuhan bulanan, dan kontribusi
outlet per produk. Domain ini TERPISAH dari War Room Ekspedisi yang sudah ada
(`ekspedisi_monthly`, key `id_outlet` per bulan) — jangan disatukan atau saling
menimpa.

## Sumber Data
Google Sheet: `1yVNeyHe3b_PLnFf3SGvLx3wuD4Gm3e6XItjiDADd_Lo`
(spreadsheet yang sama dengan War Room Ekspedisi, tab berbeda)

Sheet yang dipakai:
1. **Rev per produk** — 1 baris per produk, kolom mat/jml_bill/margin_fp per
   bulan (blok horizontal MEI/JUN/JUL/dst), plus `Vs Mei`/`Vs Jun` (selisih
   margin_fp bulan terakhir vs Mei/Juni) di ujung kolom.
2. **Rev produk per outlet** — blok horizontal per bulan, 5 kolom per blok:
   tanggal, id_outlet, id_produk, jml_bill, margin_fp.

## Format Data
Lihat komentar di `apps-script-ekspedisi-produk.js` (`ep_parseRevPerProduk_`,
`ep_parseRevProdukPerOutlet_`) untuk detail parsing baris/kolom. Aturan kunci:
- Baris `TOTAL` dan `Deviasi` di "Rev per produk" TIDAK dimasukkan sebagai produk.
- Blok bulan dideteksi dinamis dari baris label (bukan hardcode posisi kolom)
  — bulan baru otomatis terbaca tanpa ubah script, asal label bulan dikenali
  (MEI/JUN/JUL/dst, lihat `EP_MONTH_ALIASES`).
- `Vs Mei`/`Vs Jun` hanya berlaku untuk bulan TERAKHIR (kolom paling kanan);
  bulan lain punya `vs_mei`/`vs_jun` = null.
- Baris kosong (tanpa id_outlet & id_produk) di "Rev produk per outlet" dilewati.

## Database
Migration: `backend/src/migrations/create_ekspedisi_produk.sql`
Runner: `backend/scripts/run-ekspedisi-produk-migration.js`

| Tabel | Key | Isi |
|---|---|---|
| `ekspedisi_produk_summary` | UNIQUE(bulan, id_produk) | mat, jml_bill, margin_fp, vs_mei, vs_jun per produk per bulan |
| `ekspedisi_produk_outlet` | UNIQUE(bulan, tanggal, id_outlet, id_produk, source_row) | detail transaksi produk per outlet per tanggal |
| `ekspedisi_produk_sync_log` | id SERIAL | riwayat sync (sukses/gagal, jumlah baris, duplikat) |
| `ekspedisi_produk_config` | UNIQUE(sync_key) | source_url, as_of_date, day_number, daftar bulan (month_list) dari sync terakhir |

## Backend Endpoints (`backend/src/routes/warroom-ekspedisi-produk.js`)
Didaftarkan di `backend/src/app.js` SEBELUM catch-all `/api/warroom` (sync
endpoint bypass JWT, sesuai pola war-room lain).

| Endpoint | Auth | Keterangan |
|---|---|---|
| `POST /api/warroom/ekspedisi-produk/sync` | token `x-sync-token` / `Authorization: Bearer` / body `token`, dari ENV `EKSPEDISI_PRODUK_SYNC_TOKEN` (TIDAK ADA fallback hardcode — 401 kalau env belum diset) | Replace-per-bulan: hapus data lama HANYA untuk bulan yang dikirim, insert ulang dalam 1 transaksi |
| `GET /api/warroom/ekspedisi-produk/months` | JWT | Daftar bulan tersedia `{bulan, label}` |
| `GET /api/warroom/ekspedisi-produk/analytics?bulan=` | JWT | KPI, product list, top products, outlet summary, matrix summary, insight, action summary, data quality |
| `GET /api/warroom/ekspedisi-produk/outlets?bulan=&id_produk=&page=&limit=&search=` | JWT | Detail outlet per produk, pagination (default 50, max 500) |

## Apps Script (`apps-script-ekspedisi-produk.js`)
Fungsi: `previewEkspedisiProdukPayload()`, `pushEkspedisiProdukSemua()`,
`setupEkspedisiProdukTrigger()` (BELUM diaktifkan), `deleteEkspedisiProdukTriggers()`.

Script Properties yang wajib diisi di Apps Script Editor (Project Settings):
- `EKSPEDISI_PRODUK_SYNC_TOKEN` — harus sama dengan env server
- `EKSPEDISI_PRODUK_SYNC_URL` — default `https://bmsretail.my.id/api/warroom/ekspedisi-produk/sync` kalau dikosongkan

Cara pakai: jalankan `previewEkspedisiProdukPayload()` dulu (cek Logger — TIDAK
mengirim apa pun), baru `pushEkspedisiProdukSemua()` (kirim ke server, jalankan
manual — trigger otomatis belum diaktifkan).

## Frontend
- Route: `/war-room/ekspedisi-produk`
- Page: `frontend/src/pages/WarRoomEkspedisiProduk.jsx`
- Menu: War Room Ekspedisi > **Produk Ekspedisi** (badge `PROD`, warna `#0EA5E9`)
- Service API: `getEkspedisiProdukMonths`, `getEkspedisiProdukAnalytics`,
  `getEkspedisiProdukOutlets` (`frontend/src/services/api.js`)
- CSS prefix: `eprod-*` (`frontend/src/index.css`), pakai CSS variable
  (`--bg-card`, `--bg-elevated`, `--bg-hover`, `--border`, `--text-1..4`) —
  kompatibel dark/light mode.

## KPI Definitions
- `avg_margin_per_bill` = `margin_fp / jml_bill`
- `avg_bill_per_mat` = `jml_bill / mat`
- `margin_growth_*_pct` = `(margin_fp_current - margin_fp_pembanding) / margin_fp_pembanding`
- Vs Mei / Vs Juni (level total) dihitung terhadap total margin_fp bulan Mei/Juni
  DI TAHUN YANG SAMA dengan bulan aktif (bukan vs_mei/vs_jun mentah per produk).

## Status & Priority Logic
| Status | Kondisi |
|---|---|
| `no_data` | Tidak ada data produk ini di bulan sebelumnya |
| `zero_activity` | margin_fp bulan ini = 0 |
| `naik` | growth margin > +5% |
| `turun` | growth margin < -5% |
| `stabil` | selain di atas |

| Prioritas | Kondisi |
|---|---|
| P0 | Status turun, produk besar (margin_fp ≥ median), growth ≤ -20% |
| P1 | Status turun (selain P0) |
| P2 | Status stabil |
| P3 | Status naik dengan growth > +20% |
| P4 | `no_data` / `zero_activity` / isu data quality |

## Data Quality Checks
Lihat implementasi lengkap di `analyticsHandler` — mencakup formula error,
ID produk hilang saat sync, nama produk kosong, MAT/Jml Bill/Margin FP tidak
terbaca, produk tanpa detail outlet, ID produk di outlet tapi tidak ada di
summary, duplikat baris saat sync terakhir, bulan terdeteksi kurang dari 3,
dan mismatch Jml Bill antara summary vs outlet (>20%).

## Deploy / Sync Steps
1. `node backend/scripts/run-ekspedisi-produk-migration.js` (di server, setelah backup DB).
2. Set env `EKSPEDISI_PRODUK_SYNC_TOKEN` di `backend/.env` server (backup `.env` dulu).
3. `python scripts/safe_deploy.py --execute` (build frontend + reload PM2 + health check).
4. Pasang `apps-script-ekspedisi-produk.js` ke Apps Script Editor pada Google Sheet,
   set Script Properties, jalankan `previewEkspedisiProdukPayload()` lalu
   `pushEkspedisiProdukSemua()` SEKALI (manual, dari akun Google pemilik sheet —
   AI tidak punya akses ke Apps Script Editor).
5. Validasi: `GET /months`, `GET /analytics?bulan=`, `GET /outlets?bulan=&id_produk=`.

## Troubleshooting
- **401 saat sync**: cek `EKSPEDISI_PRODUK_SYNC_TOKEN` sudah di-set di server DAN
  Script Properties Apps Script — token harus identik di kedua sisi.
- **summary/outlet rows = 0 saat preview**: kemungkinan nama sheet tab berubah
  ("Rev per produk" / "Rev produk per outlet") atau baris label bulan tidak
  dikenali — cek `EP_MONTH_ALIASES` dan posisi baris label di sheet.
- **Angka salah 100x atau desimal hilang**: cek `safeNumber_` — pastikan
  `typeof value === 'number'` dicek DULU sebelum treat sebagai string (insiden
  historis Speedcash).
- **Data bulan lama tertimpa tidak sengaja**: sync HANYA menghapus data untuk
  bulan yang ada di `months[]` payload — kalau bulan lama hilang, cek apakah
  Apps Script mengirim rentang bulan yang tidak diinginkan.
