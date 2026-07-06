# Quick Win Q3 IQWM (Winme & InstaQRIS) — Dokumentasi Teknis

## 1. Status & Scope

**Prompt 1 (selesai)** = backend saja: migration, sync endpoint, analytics endpoint, dokumentasi.
**Prompt 2 (selesai)** = Apps Script (baca 3 sheet, kirim payload terstruktur ke `/sync`) — lihat §14 di bawah. Trigger otomatis TIDAK diaktifkan, sync production TIDAK dijalankan.
**Prompt 3 (selesai)** = Validasi preview Apps Script terhadap sheet asli (§14) + Frontend (halaman `/war-room/quick-win-q3`, menu sidebar) — lihat §15 di bawah.
**Prompt 4 (selesai)** = Deploy production: migration `iqwm_qw_*` (4 tabel), env `QUICK_WIN_Q3_SYNC_TOKEN` di server + Script Properties Apps Script, build+deploy via `safe_deploy.py`, sync manual `pushQuickWinQ3Semua()` (resume=6, breakdown=221, sukses), validasi endpoint & fitur lama. Trigger otomatis Apps Script TIDAK diaktifkan (menunggu persetujuan terpisah).

Sejak Prompt 4, fitur ini LIVE di production (`/war-room/quick-win-q3`, periode `2026-Q3`). Sync selanjutnya masih manual (jalankan `pushQuickWinQ3Semua()` di Apps Script) sampai trigger otomatis disetujui.

## 2. Tujuan Fitur

Monitoring target Quick Win Q3 2026 untuk Winme & InstaQRIS: target vs realisasi (target & revenue), gap, estimasi akhir Q3, status (Aman/Waspada/Kritis/Overperform), PIC, dan breakdown bulanan/mingguan per produk.

## 3. Sumber Data — 3 Sheet

| Sheet | Isi | Masuk ke tabel |
|---|---|---|
| **Resume IQWM** | Summary 3 Quick Win Winme + 3 Quick Win InstaQRIS (target/realisasi/PIC/estimasi) | `iqwm_qw_resume` |
| **Breakdown Target Instaqris** | Target & realisasi bulanan/mingguan InstaQRIS (NMAT, Revenue, MAT, Transaksi, Device Adoption) | `iqwm_qw_breakdown` (product='InstaQRIS') |
| **Breakdown Target Winme** | Target & realisasi bulanan/mingguan Winme (MAT, Revenue, Registrasi, Produk Terjual) | `iqwm_qw_breakdown` (product='Winme') |

**Perubahan format penting**: versi lama breakdown hanya InstaQRIS. Sekarang breakdown ADA UNTUK KEDUA PRODUK — kolom `product` di `iqwm_qw_breakdown` sengaja generik (bukan diasumsikan InstaQRIS), supaya produk ketiga di masa depan tidak butuh migration baru.

Google Sheet: `1fZ-4EWsOHy-Slhq1F_jLxOCgFjGd9mp5K5Xt8BIFFgI` (URL disimpan di `iqwm_qw_period_config.source_url`, dikirim Apps Script — TIDAK di-hardcode di backend).

## 4. Tabel Database

| Tabel | Key | Fungsi |
|---|---|---|
| `iqwm_qw_resume` | UNIQUE(periode, product, quickwin_no) | Summary per Quick Win (Resume IQWM) |
| `iqwm_qw_breakdown` | UNIQUE(periode, product, quickwin_no, metric_label, month_key, week_label) | Detail bulanan/mingguan per metric |
| `iqwm_qw_sync_log` | id serial | Log setiap sync (sukses/gagal), termasuk jumlah duplikat terdeteksi |
| `iqwm_qw_period_config` | PK periode | Info periode (tanggal mulai/selesai, as-of-date, sumber sheet) |

Migration: `backend/src/migrations/create_quick_win_q3_iqwm.sql` (idempotent — `CREATE TABLE/INDEX IF NOT EXISTS`). Runner: `backend/scripts/run-quick-win-q3-migration.js`. **Belum dijalankan ke production** — hanya disiapkan.

## 5. Endpoint

| Method | Path | Auth |
|---|---|---|
| `POST` | `/api/warroom/quick-win-q3/sync` | Token (`x-sync-token` atau `Authorization: Bearer`), **bukan** JWT |
| `GET`  | `/api/warroom/quick-win-q3/periods` | JWT (`requireAuth`) |
| `GET`  | `/api/warroom/quick-win-q3/analytics?periode=2026-Q3` | JWT (`requireAuth`) |

Didaftarkan di `app.js` — route sync diregistrasi **sebelum** `app.use('/api/warroom', requireAuth, ...)`, mengikuti pola BRIC yang sudah ada.

**Token sync**: `QUICK_WIN_Q3_SYNC_TOKEN` — env var terpisah, TIDAK ADA fallback hardcoded di kode (`process.env.QUICK_WIN_Q3_SYNC_TOKEN` polos). Kalau env belum diisi di server, endpoint sync akan selalu menolak (401) sampai admin mengisinya — fail-safe by default, bukan fail-open. Nilai dummy contoh sudah ditambahkan ke `backend/.env.example` (bukan value asli).

## 6. Payload Contract (untuk Apps Script — dibuat di Prompt 2)

```json
{
  "periode": "2026-Q3",
  "label": "Q3 2026",
  "period_start": "2026-07-01",
  "period_end": "2026-09-30",
  "as_of_date": "2026-07-06",
  "total_days": 92,
  "days_elapsed": 5,
  "source_url": "https://docs.google.com/spreadsheets/d/.../edit",
  "resume": [ { "product": "Winme", "quickwin_no": 1, "point_quickwin": "...", "target_label": "MAT : 3.000", "target_value": 3000, "target_revenue": 50000000, "realization_target": 41, "realization_target_pct": 0.0136, "realization_revenue": 265844, "realization_revenue_pct": 0.0053, "pic": "Yohana", "estimated_end_q3": 0, "estimated_target_value_end_q3": 0, "source_sheet": "Resume IQWM", "source_row": 3, "raw_data": {} } ],
  "breakdown": [ { "product": "InstaQRIS", "quickwin_no": 1, "point_quickwin": "...", "metric_label": "NMAT", "metric_type": "target", "month_key": "2026-07", "month_label": "Juli 2026", "week_label": "week_1", "week_start": null, "week_end": null, "target_value": 0, "realization_value": 0, "source_sheet": "Breakdown Target Instaqris", "source_row": 2, "raw_data": {} } ],
  "meta": { "sheet_names": ["Resume IQWM", "Breakdown Target Instaqris", "Breakdown Target Winme"], "synced_by": "apps_script" }
}
```

Sync: **replace per periode** (bukan append) — `DELETE ... WHERE periode=$1` untuk resume & breakdown, lalu insert ulang, semua dalam 1 transaction (BEGIN/COMMIT/ROLLBACK). Periode lain sama sekali tidak tersentuh.

## 7. Parser Angka & Formula Error

Helper di `warroom-quick-win-q3.js`:

| Fungsi | Aturan |
|---|---|
| `safeNumber(v)` | number asli langsung dipakai (guard `typeof === 'number'` duluan — anti insiden Speedcash 100x). String: buang "Rp", buang **titik DAN koma** (di sheet ini keduanya berarti pemisah ribuan, contoh "1.000"/"1,000" sama-sama seribu, bukan desimal) |
| `safePercent(v)` | number asli langsung dipakai. String: buang "%", **koma dianggap desimal** ("55,18%" gaya Indonesia — beda dari safeNumber karena persen tidak butuh pemisah ribuan), hasil selalu 0..1 |
| `isFormulaError(v)` | true untuk `#NAME?`, `#DIV/0!`, `#VALUE!`, `#N/A`, `#REF!`, `#NULL!`, `#NUM!` (exact match, case-insensitive) |
| `safeDiv(a,b)` | null kalau `b` 0/null/invalid — tidak pernah NaN/Infinity |

Semua fungsi mengembalikan `null` (bukan 0) untuk input yang tidak terbaca — supaya data quality bisa membedakan "nilainya nol" vs "tidak terbaca". 1 baris kotor tidak pernah melempar exception (try/catch di level transaksi, bukan per-baris, karena parser sendiri tidak pernah throw).

## 8. Definisi Status

`calculateStatus(realizationPct, progressTimePct, estimatedPct)`:

| Kondisi | Status |
|---|---|
| `realizationPct` null | `no_data` |
| `realizationPct >= 1` | `overperform` |
| `realizationPct >= progressTimePct × 0.9` | `aman` |
| `realizationPct >= progressTimePct × 0.6` | `waspada` |
| selain itu | `kritis` |

`estimatedPct` (rasio estimasi akhir Q3 / target) dipakai sebagai sinyal tambahan **leading indicator** — bisa menaikkan/menurunkan status **maksimal 1 tingkat** (tidak pernah melompat 2 tingkat dari 1 sinyal tambahan saja): `estimatedPct >= 1` naik 1 tingkat, `estimatedPct < 0.7` turun 1 tingkat. Ini interpretasi backend atas requirement "estimated_end_q3 vs target_revenue" di spesifikasi — didokumentasikan di sini karena keputusan desain, bukan aturan yang eksplisit di sheet.

`progressTimePct` = `days_elapsed / total_days` (atau dihitung dari `period_start/period_end/as_of_date` kalau `total_days`/`days_elapsed` tidak dikirim).

**Status per Quick Win** dihitung dari `realization_revenue_pct` (kalau `target_revenue > 0`), fallback ke `realization_target_pct` (kalau `target_value > 0`), fallback `no_data`.

**Status bulanan/mingguan** memakai `progress_time_pct` KHUSUS bulan/minggu itu (bukan progress Q3 keseluruhan) — `monthProgressPct()`/`weekProgressPct()` menghitung: bulan/minggu yang sudah lewat = 100%, yang akan datang = 0%, yang sedang berjalan = proporsional hari berjalan. Kalau `week_start`/`week_end` null (belum dikirim Apps Script), fallback ke `progress_time_pct` Q3 keseluruhan.

**Priority** = pemetaan langsung dari status: `kritis→P0, waspada→P1, aman→P2, overperform→P3, no_data→P4`.

## 9. Data Quality Checks

`formula_error_count`, `missing_product`, `missing_point_quickwin`, `missing_pic`, `invalid_target_revenue`, `invalid_realization`, `invalid_percentage`, `breakdown_missing_month` (fleksibel — cek SEMUA produk yang ada di resume, bukan cuma 2), `duplicate_quickwin` (dideteksi saat sync, sebelum upsert menghilangkan jejaknya — disimpan di `sync_log.payload_meta`), `missing_breakdown_winme`, `missing_breakdown_instaqris` (2 check khusus sesuai permintaan — beda dari `breakdown_missing_month` yang generik), `summary_breakdown_mismatch` (selisih revenue Resume vs total Breakdown per produk >20%, threshold didokumentasikan di sini karena tidak ada acuan resmi).

Severity: `low` (count=0), `medium` (1-2), `high` (≥3) — heuristik sederhana, bisa direvisi.

## 10. Insight & Action Summary

Insight (maks 5): revenue di bawah pace, Quick Win tanpa realisasi sama sekali, estimasi akhir Q3 <70% target, gap antar-produk >30 poin persen, breakdown mingguan banyak yang kritis (>30%), data quality issue >0. Hanya insight yang triggered yang tampil (bisa 0-5).

Action summary (maks 20): 1 entri per Quick Win non-`no_data` (priority P0-P3 sesuai status) + 1 entri per data quality check yang count>0 (priority P4). Total quick win hanya ~6, jadi jauh di bawah cap 20.

## 11. Batasan MVP

- Data quality `GET /data-quality` terpisah **tidak dibuat** — sesuai izin "boleh digabung ke analytics dulu", semua sudah ada di `analytics.data_quality`.
- Status bulanan/mingguan pakai pace SPESIFIK bulan/minggu itu (lihat §8) — ini lebih presisi dari sekadar reuse progress_time_pct Q3, tapi kalau `week_start/week_end` tidak pernah dikirim Apps Script, weekly status akan selalu fallback ke pace Q3 (kurang presisi, bukan salah).
- `summary_breakdown_mismatch` pakai threshold 20% yang belum divalidasi ke business owner.
- `raw_data` JSONB disimpan lengkap di DB untuk audit, TAPI TIDAK PERNAH dikirim ke response `/analytics` (sesuai batasan performa) — hanya dipakai internal untuk cek formula error.

## 12. Catatan Formula Error

Google Sheet formula error (`#NAME?`, `#DIV/0!`, `#VALUE!`, `#N/A`, `#REF!`) TIDAK PERNAH membuat backend crash — `safeNumber`/`safePercent` mendeteksinya lewat `isFormulaError()` dan mengembalikan `null` (bukan melempar exception), lalu masuk hitungan `formula_error_count` di data quality (dicek dari `raw_data` yang disimpan mentah, bukan dari kolom numerik yang sudah ter-null-kan — supaya tetap terdeteksi meski nilai aslinya sudah "hilang" jadi null).

## 13. Rencana Prompt Berikutnya

- **Prompt 3 — Frontend**: halaman `/war-room/quick-win-q3`, menu di Winme & InstaQRIS → War Room → Quick Win Q3.
- **Prompt 4 — Deploy**: migration production (`node backend/scripts/run-quick-win-q3-migration.js` via SSH), isi `QUICK_WIN_Q3_SYNC_TOKEN` (dan opsional `QUICK_WIN_Q3_SYNC_URL`) di Script Properties Apps Script DAN di env production, build+deploy backend via `safe_deploy.py`, baru setelah itu jalankan `pushQuickWinQ3Semua()` sungguhan.

## 14. Apps Script (Prompt 2)

File: `apps-script-quick-win-q3-iqwm.js` (root repo — source untuk di-copy-paste ke Google Apps Script Editor, TIDAK dijalankan dari repo).

### Cara pasang

1. Buka spreadsheet Quick Win Q3 IQWM → Extensions → Apps Script.
2. Hapus/isi kosongkan `Code.gs` default, paste seluruh isi `apps-script-quick-win-q3-iqwm.js`.
3. Project Settings (ikon gear) → Script Properties → tambah:
   - `QUICK_WIN_Q3_SYNC_TOKEN` — **wajib**, minta nilai asli ke admin BRIC. TIDAK PERNAH ditulis di kode script maupun di repo ini.
   - `QUICK_WIN_Q3_SYNC_URL` — opsional, default sudah benar (`https://bmsretail.my.id/api/warroom/quick-win-q3/sync`) kalau dikosongkan.
4. Jalankan `previewQuickWinQ3Payload()` dari dropdown fungsi di toolbar Apps Script Editor. Cek hasil di **View → Logs**.
5. Cek jumlah resume rows (harus 6: 3 Winme + 3 InstaQRIS), jumlah breakdown rows, dan daftar warning. **Kalau breakdown 0 rows** — lihat §Risiko Parsing di bawah, JANGAN lanjut ke langkah 6 dulu.
6. **Jangan jalankan `pushQuickWinQ3Semua()` sebelum migration backend production selesai** (Prompt 4) — tabel belum ada di database production.
7. Setelah migration + `QUICK_WIN_Q3_SYNC_TOKEN` production siap, jalankan `pushQuickWinQ3Semua()` manual dan cek responsnya di Logger.
8. Trigger otomatis (`setupQuickWinQ3Trigger()`) TIDAK dijalankan sekarang — baru dijalankan manual setelah sync manual tervalidasi berkali-kali datanya benar.

### Fungsi publik

| Fungsi | Fungsi |
|---|---|
| `previewQuickWinQ3Payload()` | Dry-run — build payload, TIDAK mengirim ke backend, tampilkan ringkasan + sample + warning di Logger. |
| `pushQuickWinQ3Semua()` | Build payload, validasi, POST ke `/sync` dengan `x-sync-token`. Token/URL dari Script Properties, tidak pernah di-log. |
| `setupQuickWinQ3Trigger()` | Buat trigger harian (06:00 WIB) untuk `pushQuickWinQ3Semua()`. **Jangan jalankan sebelum sync manual tervalidasi.** |
| `deleteQuickWinQ3Triggers()` | Hapus trigger `pushQuickWinQ3Semua` kalau ada — safety net. |

### Cara kerja parser Resume IQWM

Scan semua baris: deteksi section product dari teks baris yang mengandung "WINME"/"INSTAQRIS" (lewat `normalizeProduct_()`), deteksi baris header dari teks "Point Quick Win" (di-skip, bukan data), lalu setiap baris berikutnya dengan kolom A (No.) numerik DAN kolom B (Point Quick Win) tidak kosong dianggap 1 Quick Win. Baris "Total" di-skip eksplisit. `target_value` diambil dari angka di akhir `target_label` (mis. "MAT : 3.000" → 3000). Kalau jumlah baris ≠ 6, masuk warning (bukan error fatal).

### Cara kerja parser Breakdown (Instaqris & Winme)

**Asumsi layout yang BELUM bisa diverifikasi langsung** (spreadsheet privat, tidak bisa diakses read-only dari sini): parser mencari baris section "TARGET" dan "REALISASI"/"REALIZATION"/"AKTUAL" secara otomatis (bukan index baris/kolom hardcode), lalu baris header bulan (Juli/Agustus/September/Q3) di atas section TARGET, lalu baris header minggu (Week 1-5/W1-5/Minggu 1-5/Total Bulan/Q3 Total) tepat di bawahnya. Baris metric (NMAT/Revenue/MAT/dst di kolom pertama) dicari di dalam masing-masing section dan dipasangkan by nama. **Kalau salah satu section/header tidak ketemu, breakdown sheet itu dilewati (0 rows) + warning jelas — parser TIDAK PERNAH menebak/invent angka.**

`quickwin_no`/`point_quickwin` breakdown row dibiarkan `null` — sheet breakdown terorganisir per metric+bulan+minggu, bukan per Quick Win, dan tidak ada kolom yang menyebutkan quickwin_no di deskripsi sheet yang tersedia.

### Formula error (#NAME?, #DIV/0!, dst.)

`safeNumber_`/`safePercent_` mengecek `isFormulaError_()` di kedua sumber (`getValues()` DAN `getDisplayValues()`) sebelum parsing string — kalau formula error, return `null` (tidak pernah throw). `formula_error_count` dihitung dari `raw_data` yang tersimpan (bukan dari field numerik yang sudah ter-null-kan), supaya tetap terdeteksi.

### Parse warnings

Semua masalah non-fatal (PIC kosong, revenue tidak terbaca, section breakdown tidak ketemu, jumlah resume ≠ 6, dll) masuk `payload.meta.parse_warnings[]` — TIDAK menghentikan proses. Masalah fatal (sheet Resume IQWM tidak ditemukan, token kosong saat push, field numerik jadi NaN/Infinity karena bug parser) melempar `Error` dengan pesan aman (tanpa credential).

### Breakdown Winme & InstaQRIS

Keduanya WAJIB ada (format baru, bukan cuma InstaQRIS) — `collectDataQuality_()` menambahkan warning `missing_breakdown_winme`/`missing_breakdown_instaqris` ke `parse_warnings` kalau salah satu 0 rows, TAPI payload tetap dikirim (tidak fatal), sesuai instruksi.

### Validasi Preview terhadap Sheet Asli (Prompt 3, Part A)

`previewQuickWinQ3Payload()` sudah dijalankan langsung oleh pemilik project terhadap spreadsheet Quick Win Q3 asli (bukan simulasi). Hasil awal (parser versi Prompt 2) **gagal** — resume terbaca 5/6, breakdown 0 rows untuk kedua produk. Setelah 2 perbaikan (lihat riwayat di bawah), hasil akhir:

- **Resume: 6/6** (3 Winme + 3 InstaQRIS) — benar.
- **Breakdown: 221 rows total** — InstaQRIS=119, Winme=102. Diverifikasi manual: InstaQRIS 7 kombinasi metric×QuickWin × (6 baris Juli [1 month_total + 5 minggu] + 5 baris Agustus [1 + 4 minggu] + 6 baris September [1 + 5 minggu]) = 7×17 = 119. Winme 6 kombinasi × 17 = 102. **Cocok persis** dengan hasil Logger.
- **Data quality warnings: 0.**
- Sample data masuk akal: minggu yang belum berjalan (mis. `week_2` di bulan Juli, karena `as_of_date` masih di minggu 1) tampil `realization_value: null` — bukan `0` yang dipaksakan — sesuai aturan "jangan invent angka".

### Riwayat Perbaikan Parser (root cause + fix)

**Bug 1 — Resume terbaca 5, bukan 6.** Deteksi section produk ("WINME"/"InstaQRIS") awalnya mencari kata itu di **seluruh baris yang digabung** (semua kolom). Salah satu Quick Win Winme punya teks *Point Quick Win* yang mengandung kata "Winme" ("...Buyer Network **Winme** via Open Cataloque Saas") — baris data ini keliru terdeteksi sebagai section-marker baru dan hilang dari hasil. **Fix**: deteksi section sekarang HANYA mencocokkan kolom A secara *exact match* (`colA === 'WINME'`), tidak lagi substring di seluruh baris.

**Bug 2 — Breakdown 0 rows untuk kedua sheet.** Parser Prompt 2 menebak ada 2 section terpisah berlabel "TARGET" dan "REALISASI". Layout sheet sebenarnya (dikonfirmasi lewat `debugQuickWinQ3Sheets_()`, fungsi diagnostik yang ditambahkan khusus untuk ini) sama sekali berbeda:
- Section per bulan ditandai baris berisi HANYA nama bulan di kolom A ("Juli"/"Agustus"/"September").
- Baris tepat di bawahnya = header minggu dengan kolom **Target Week N dan Realisasi Week N berselang-seling** (bukan 2 blok terpisah), plus kolom "Target Result" (target bulanan) dan "Total Realisasi" (realisasi bulanan).
- Jumlah minggu **berbeda per bulan** (Juli & September = 5 minggu, Agustus = 4 minggu) dan label kolom terakhir tidak konsisten (kadang "Realisasi" %, kadang "GAP TARGET").

**Fix**: `parseBreakdownSheet_` ditulis ulang total — deteksi marker bulan + parsing header minggu dinamis (`qw3ParseWeekSectionHeader_`, mencocokkan teks "Target Week N"/"Realisasi Week N" per kolom, bukan index hardcode, tahan terhadap cell multi-baris seperti `"Target Week 1 (10%)\n1-5 Juli"`), dan **realization_pct/gap_value selalu dihitung sendiri** (tidak mengandalkan kolom terakhir sheet yang labelnya tidak konsisten). Sekaligus ditambahkan pencocokan `quickwin_no` ke Resume IQWM (best-effort, exact text match pada `point_quickwin`) — sebelumnya selalu `null`.

Fungsi diagnostik `debugQuickWinQ3Sheets_()` (dump mentah 40 baris pertama tiap sheet, read-only) tetap disimpan di script untuk debugging di masa depan kalau layout sheet berubah lagi.

## 15. Frontend (Prompt 3)

### Route & Menu
- Route: `/war-room/quick-win-q3` → komponen `WarRoomQuickWinQ3` (`frontend/src/pages/WarRoomQuickWinQ3.jsx`), dibungkus `ProtectedRoute` sama seperti route lain.
- Menu sidebar: **Winme & InstaQRIS → War Room → Quick Win Q3**, diletakkan tepat di bawah "InstaQRIS Command Center" dan di atas "Instaqris - Analitik". Badge `Q3` warna `#0EA5E9`. Accordion Winme & InstaQRIS auto-open untuk route ini (`isWRQw3Path` di `Sidebar.jsx`).
- Service API: `frontend/src/services/api.js` — `getQuickWinQ3Periods()` dan `getQuickWinQ3Analytics(periode)`. TIDAK di-cache (data per-periode, sama pola dengan DM Control Tower/InstaQRIS Command Center).

### Komponen Halaman
1 halaman panjang (bukan tab) dengan urutan: Header (filter periode, last sync) → Progress Waktu Q3 (progress bar) → banner warning formula error (kalau `formula_error_count > 0`) → 9 KPI card eksekutif → Perbandingan Produk (card per produk + progress bar) → Filter Produk (All/Winme/InstaQRIS) → Daftar Quick Win (card, difilter produk) → Breakdown Bulanan (table, grouped product+bulan) → Breakdown Mingguan (table, default 25 baris + toggle "Lihat Semua", difilter produk) → Insight (maks 5) → Prioritas Aksi (difilter produk untuk yang punya `product`, P4 Data Quality selalu tampil) → Kualitas Data.

### Filter Produk
Satu filter global (All/Winme/InstaQRIS) mempengaruhi: Daftar Quick Win, Breakdown Bulanan, Breakdown Mingguan, dan Prioritas Aksi (khusus entri yang punya field `product`; entri P4 Data Quality tanpa produk selalu tampil apa pun filternya). **Insight TIDAK difilter** — backend tidak mengirim field `product` pada objek insight, jadi tidak ada dasar untuk memfilternya per produk.

### Cara Membaca KPI
- **Target Revenue Q3** / **Realisasi Revenue** / **% Revenue Achievement**: agregat seluruh Quick Win.
- **Estimasi Akhir Q3**: total `estimated_end_q3` semua Quick Win, dengan sub-teks % dari target.
- **Gap ke Target**: `total_gap_revenue` — ditandai merah (alert) kalau positif (masih ada kekurangan).
- **Quick Win Total/Kritis/Waspada/Aman-Overperform**: jumlah Quick Win per status.

### Cara Membaca Status
Badge warna: `aman` (hijau), `waspada` (kuning/amber), `kritis` (merah), `overperform` (ungu), `no_data` (abu-abu). Semua status dihitung backend (lihat §8) — frontend hanya menampilkan, tidak menghitung ulang.

### Cara Membaca Breakdown Bulanan
Table dikelompokkan per (produk, bulan) — 1 baris per metric (NMAT/Revenue/MAT/dst). Kolom Target/Realisasi/%/Gap dihitung backend dari SUM seluruh baris mingguan bulan itu (baris agregat `month_total`/`q3_total` dari Apps Script sengaja diabaikan backend untuk menghindari double count — lihat catatan di `warroom-quick-win-q3.js`).

### Cara Membaca Breakdown Mingguan
Table per (produk, Quick Win, metric, bulan, minggu) — bisa sampai ratusan baris (contoh nyata: 221 baris untuk 1 periode), jadi default hanya tampil 25 baris pertama + tombol "Lihat Semua". Kolom Realisasi menampilkan teks *"belum terjadi"* (bukan `0`) kalau `realization_value` masih `null` — artinya minggu itu belum berjalan berdasarkan `as_of_date`, BUKAN berarti realisasinya nol.

### Data Quality Warning
Kalau `data_quality` punya entri `formula_error_count` dengan `count > 0`, tampil banner kuning di atas KPI: *"Google Sheet masih memiliki formula error. Angka terkait akan dibaca sebagai null/0 agar dashboard tidak error."* — sesuai instruksi, dan sudah teruji tidak membuat halaman crash (dicek lewat data quality checks §9, semua defensif terhadap null).

### Dark Mode Support
Semua CSS baru pakai prefix `qw3-*`, ditulis SEJAK AWAL memakai variabel token (`var(--bg-card)`, `var(--bg-elevated)`, `var(--bg-page)`, `var(--bg-hover)`, `var(--border)`, `var(--text-1..4)`, `var(--bg-table-header)`, `var(--bg-table-hover)`) — TIDAK ADA background pastel/putih hardcoded, jadi TIDAK PERLU blok override `[data-theme="dark"]` terpisah seperti prefix-prefix lama (beda dari audit kontras dark mode sebelumnya yang harus menambal banyak class lama). Hanya 2 pengecualian kecil yang di-override manual untuk dark mode: warna teks rekomendasi (`.qw3-quickwin-reko`/`.qw3-insight-reko`, ungu tua → ungu terang) dan warna KPI alert (merah tua → merah terang), supaya tetap kontras di atas card gelap.

### Empty State
- Belum ada periode sama sekali: *"Data Quick Win Q3 belum tersedia. Jalankan migration dan sync Google Sheet terlebih dahulu."*
- Periode ada tapi backend balas `empty: true`: *"Tidak ada periode Quick Win Q3 yang tersedia."*
- Breakdown bulanan/mingguan kosong (misal karena parser Apps Script belum jalan atau sync belum pernah dilakukan): *"Breakdown belum tersedia atau parser Apps Script perlu dicek."*
- Loading & error state standar (spinner / pesan error dari API, tidak pernah menampilkan stack trace/credential).

### Chart
**Sengaja TIDAK memakai Chart.js** untuk halaman ini — progress bar CSS sederhana (`.qw3-progress-track`/`.qw3-progress-fill`) dipakai untuk visualisasi Progress Waktu Q3 dan Revenue Achievement per produk/Quick Win, sudah cukup "actionable dan mudah discan" tanpa risiko tambahan (data kosong/null di banyak baris breakdown mingguan berisiko kalau dipetakan ke chart canvas). Sesuai instruksi "jangan memaksa chart jika bikin risiko besar".

### Batasan MVP Frontend
- Tidak ada drilldown per outlet/detail transaksi (fitur ini levelnya Quick Win, bukan outlet — sesuai scope Prompt 1 backend yang juga tidak menyediakan data outlet-level).
- Breakdown Bulanan & Mingguan murni tabel (bukan chart) — cukup untuk MVP, bisa ditambah visualisasi di iterasi berikutnya kalau dibutuhkan.
- Build asli (`npm run build`) diverifikasi di server saat Prompt 4 (lihat laporan akhir) — di sesi ini hanya static check (bracket/JSX-tag balance) karena Node tidak tersedia lokal.
