# InstaQRIS Command Center — Dokumentasi Teknis

> **Catatan nama fitur**: nama akhir fitur ini adalah **"InstaQRIS Command Center"**.
> Kata "CEO" TIDAK PERNAH menjadi bagian nama fitur — kata itu hanya dipakai di
> dokumen ini untuk menyebut salah satu **persona pengguna** (pemilik bisnis
> yang butuh ringkasan eksekutif cepat), bukan nama produk/menu.

## 1. Status & Scope

**Prompt 1 (selesai)** = backend analytics only:
- File baru `backend/src/routes/warroom-instaqris-command-center.js`.
- 2 endpoint GET (lihat §4), didaftarkan di `app.js` dengan `requireAuth`.
- TIDAK ADA endpoint sync baru — data tetap masuk lewat sync lama di
  `data-raw.js` (`/api/data-raw/{outlet,affiliate,qris,trx}/sync`).

**Prompt 2 (selesai)** = frontend only — halaman, route, menu sidebar, service
API, CSS baru (lihat §9). Belum di-build/deploy nyata (lihat §9 "Batasan MVP
Frontend").

**Prompt 3 (belum dikerjakan)** = deploy approval (build nyata di server,
review sebelum production).

Yang **SENGAJA TIDAK** dikerjakan di Prompt 1 & 2 (menunggu Prompt 3 atau
persetujuan eksplisit):

- Deploy ke production, migration SQL, perubahan Nginx, endpoint sync baru.
- Perubahan ke QRIS Control Tower, DM Control Tower, atau logic Data Raw yang
  sudah ada (`data-raw.js` tidak disentuh sama sekali).
- Mengaktifkan kembali `WarRoomAffiliateAnalitik.jsx` (tetap dead code).

## 2. Sumber Data & Masalah Nama Kolom

Membaca 3 tabel JSONB read-only yang sudah ada (sync-nya dikelola `data-raw.js`):

| Tabel | Isi | Key |
|---|---|---|
| `iq_raw_outlet` | Katalog outlet/merchant | `bulan` + `row_data` JSONB |
| `iq_raw_qris` | Status penerbitan QRIS | `bulan` + `row_data` JSONB |
| `iq_raw_trx` | Transaksi harian | `bulan` + `row_data` JSONB |

Sheet sumber tidak konsisten menamai kolom antar bulan/lampiran (contoh nyata
yang sudah lama diketahui: **"ID Outlet" vs "D Outlet"**). Karena itu dibuat
**helper "canonical field"**: setiap field logis punya daftar kandidat nama
kolom, dan SQL yang dihasilkan memakai `COALESCE(NULLIF(row_data->>'A',''),
NULLIF(row_data->>'B',''), ...)` — ambil yang pertama tidak kosong.

Daftar kandidat per field (bisa ditambah kalau ditemukan varian baru — cukup
tambah ke array-nya, tidak perlu ubah logic lain):

| Field logis | Kandidat kolom |
|---|---|
| `id_outlet` | ID Outlet, D Outlet, id_outlet, Id Outlet, Outlet ID, ID Loket, Kode Outlet |
| `merchant_name` | Nama Merchant, Merchant Name, nama_merchant, Nama Outlet, Nama Toko |
| `kategori` | Nama Kategori, Kategori, MCC, Category |
| `provinsi` | Provinsi, Province, nama_propinsi, Nama Propinsi |
| `kota` | Kota, City, nama_kota, Nama Kota |
| `no_hp` | No HP, No Handphone, No Telp, No Telepon, no_hp, notelp_pemilik |
| `trx` (jumlah transaksi) | Jumlah Transaksi, Transaksi, trx, total_transaction, total_trx |
| `revenue` (omzet) | Jumlah Omzet, Omzet, Revenue, revenue, Rev |
| `margin` | Margin, margin, MDR |
| `tanggal_transaksi` | Tanggal, tanggal, Tanggal Transaksi, Tgl Transaksi |
| `status_qris` | status, Status, Status QRIS, QRIS Status, Status Penerbitan |

**Penting**: `margin` dan `revenue` (omzet) adalah 2 angka **berbeda** di data
asli (lihat `data-raw.js` yang menjumlahkan keduanya terpisah) — sengaja
TIDAK digabung jadi satu kandidat supaya tidak salah tafsir.

## 3. Parser Angka & Tanggal yang Aman

Nilai JSONB `row_data->>'X'` selalu berupa **teks**, bisa berbentuk angka
bersih (`"408146.85"`) atau berformat `"Rp 98,484"`. Aturan pembersihan (versi
SQL dari aturan `cleanNum()` lama — **titik desimal TIDAK PERNAH dihapus**,
insiden Speedcash 100x karena titik ikut terhapus tidak boleh terulang):

1. Hilangkan prefix `Rp`/`rp` (opsional titik + spasi).
2. Hilangkan **koma** (pemisah ribuan) — bukan titik.
3. Validasi hasil akhir dengan regex `^-?[0-9]+(\.[0-9]+)?$` sebelum di-cast
   `::numeric`. Kalau tidak valid → dianggap `0` (baris kotor tidak boleh
   menggagalkan seluruh query agregat).

Implementasi: fungsi `numericSql()` di route file, dipakai untuk `trx`,
`revenue`, `margin`.

## 4. Endpoint

### `GET /api/warroom/instaqris-command-center/months`
Auth: JWT (`requireAuth`). Return daftar bulan yang punya data di salah satu
dari 3 tabel sumber, urut terbaru dulu:
```json
{ "months": ["2026-06", "2026-05", "2026-04", "..."] }
```

### `GET /api/warroom/instaqris-command-center/analytics?bulan=YYYY-MM`
Auth: JWT. Kalau `bulan` tidak dikirim/tidak valid/tidak ada datanya, otomatis
pakai bulan terbaru yang tersedia (pola yang sama seperti handler lain di
`data-raw.js`).

Bentuk response (ringkas — lihat kode untuk field lengkap):
```json
{
  "meta": {
    "bulan": "2026-06",
    "bulan_list": ["2026-06", "2026-05", "..."],
    "bulan_pembanding": "2026-05",
    "data_sources": {
      "outlet": { "last_synced": "2026-07-02T23:00:00.000Z" },
      "qris":   { "last_synced": "..." },
      "trx":    { "last_synced": "..." }
    }
  },
  "kpi": {
    "outlet": { "total_outlet": 13069, "outlet_tanpa_id": 55, "top_provinsi": [...], "top_kategori": [...] },
    "qris_status": { "qris_terbit": 7211, "qris_belum_terbit": 0, "qris_perbaikan_data": 30004, "qris_rejected": 20, "qris_status_lain": 0, "qris_unknown": 0, "qris_terbit_rate": 55.18, "qris_problem_rate": 80.6, "qris_terbit_growth": 3.2 },
    "transaksi": { "active_outlet_trx": 28981, "outlet_tanpa_trx": 4021, "total_trx": 1388459, "total_revenue": 0, "total_margin": 0, "avg_trx_per_active_outlet": 47.9, "avg_revenue_per_trx": 0, "active_rate": 221.8 },
    "growth": { "bulan_pembanding": "2026-05", "trx_growth_pct": 9.2, "revenue_growth_pct": null, "active_outlet_growth_pct": 7.5 }
  },
  "funnel": {
    "steps": [ { "step": "outlet_registered", "count": 13069 }, { "step": "qris_terbit", "count": 7211 }, { "step": "active_trx", "count": 28981 } ],
    "rates": { "registered_to_terbit_pct": 55.18, "terbit_to_active_pct": 401.9, "registered_to_active_pct": 221.8 }
  },
  "insights": [ { "area": "penerbitan_qris", "title": "...", "detail": "...", "severity": "high" } ],
  "action_summary": [ { "priority": "P0", "category": "data_quality", "action_type": "trx_tidak_match_outlet", "count": 23918, "recommendation": "..." } ],
  "data_quality": { "checks": [ { "check": "outlet_tanpa_id", "count": 55, "severity": "warning" } ], "total_issue_count": 24100, "issue_rate_pct": 5.8 },
  "health": { "status": "warning", "reasons": ["..."] }
}
```

**Batasan performa/ukuran yang dijaga** (sesuai permintaan): `top_provinsi` &
`top_kategori` maks 10 baris, `insights` maks 5, `action_summary` maks 20 —
dan **tidak ada satupun response yang mengembalikan daftar outlet mentah**,
semua sudah agregat/count.

## 5. Temuan Penting dari Verifikasi Data Asli (read-only, production)

Sebelum menyelesaikan Prompt 1, dilakukan beberapa query `SELECT`
read-only langsung ke database production (lewat akses SSH key yang sudah
disiapkan sebelumnya, tanpa mengubah data apapun) untuk memvalidasi asumsi:

- **`iq_raw_outlet` per bulan BUKAN daftar kumulatif all-time** — jumlah baris
  per bulan naik-turun (13069 di Juni, turun dari 13556 di Mei, sempat 15254 di
  April), bukan monoton naik. Kesimpulan: setiap bulan diperlakukan sebagai
  **snapshot mandiri** (bukan "semua outlet yang pernah terdaftar"). Endpoint
  ini mengikuti asumsi tersebut untuk `total_outlet`.
- **Outlet yang bertransaksi jauh lebih banyak dari outlet di katalog bulan
  yang sama** — Juni 2026: 28.981 outlet distinct bertransaksi vs hanya 13.069
  baris di katalog outlet bulan yang sama → `trx_tidak_match_outlet` bernilai
  besar (~23.918) secara **nyata**, bukan bug. Ini kemungkinan berarti sheet
  "Data Outlet" hanya berisi subset (mis. outlet baru/yang perlu diproses),
  bukan seluruh universe outlet yang pernah bertransaksi. **Perlu konfirmasi
  ke pemilik sheet** — dicatat sebagai insight/data-quality, bukan diperbaiki
  sepihak oleh kode ini.
- Status QRIS riil yang ditemukan di bulan Juni: `Terbit`, `Perbaikan Data`,
  `Rejected` (tidak ada `Belum Terbit` di sample ini, tapi kolom itu tetap
  didukung `bucketQrisStatus()` untuk bulan lain).
- Query paling berat (`trx_tidak_match_outlet` ~650ms, `top_performer P90`
  ~1.24s pada tabel trx 296k baris) — total estimasi waktu 1 request analytics
  ≈ 2–3 detik. Tidak berisiko 504 seperti kasus DM Control Tower (yang
  disebabkan CTE berat dihitung 13x redundant), karena di sini setiap query
  independen dan hanya dijalankan **1x** per request.

## 6. Threshold yang Dipakai (bisa direvisi bersama business owner)

| Threshold | Nilai awal | Alasan |
|---|---|---|
| `QRIS_TERBIT_RATE_LOW` | 50% | Di bawah ini dianggap bottleneck penerbitan — asumsi awal "separuh outlet harusnya sudah terbit", belum divalidasi ke target bisnis resmi |
| `ACTIVATION_RATE_LOW` | 30% | Outlet ber-QRIS-terbit yang belum transaksi dianggap bottleneck aktivasi kalau di bawah 30% |
| `DATA_QUALITY_ISSUE_RATE_HIGH` | 5% | Dari total record — dipakai juga sebagai pemicu health=warning; 2x lipat (10%) dipakai untuk health=critical |
| `ACTIVE_RATE_CRITICAL` | 5% | Outlet aktif transaksi dari total terdaftar — di bawah ini dianggap kondisi kritis |
| `REVENUE_DECLINE_WARNING` | 0% | Growth revenue negatif langsung jadi salah satu pemicu warning |
| `TOP_PERFORMER_PERCENTILE` | P90 | Dipakai untuk kandidat aksi reward/testimoni (action_summary kategori growth) |

Semua angka ini **bukan hasil tuning statistik** — hanya batas akal sehat
awal yang eksplisit didokumentasikan supaya mudah didiskusikan/direvisi, bukan
angka ajaib yang tersembunyi di kode.

## 7. Data Quality Checks

| Check | Arti |
|---|---|
| `outlet_tanpa_id` | Baris di `iq_raw_outlet` tanpa ID outlet yang bisa dikenali dari kandidat manapun |
| `trx_tanpa_id` | Baris di `iq_raw_trx` tanpa ID outlet |
| `qris_tanpa_id` | Baris di `iq_raw_qris` tanpa ID outlet |
| `trx_tidak_match_outlet` | ID outlet di `iq_raw_trx` (bulan X) tidak ditemukan di `iq_raw_outlet` (bulan X) |
| `qris_status_unknown` | Status QRIS kosong/null (beda dengan `status_lain` yang berarti ada teks tapi tidak dikenali) |
| `duplicate_outlet_id` | ID outlet muncul lebih dari 1x dalam `iq_raw_outlet` bulan yang sama |
| `month_data_missing` | Salah satu dari 3 sumber (outlet/qris/trx) tidak punya baris sama sekali untuk bulan tsb |

## 8. Bottleneck Insight & Action Summary — Cara Kerja

**Insight (maks 5)**: aturan pemicu tetap (lihat §6 untuk threshold), murni
dihitung di JS dari angka-angka yang sudah diagregasi SQL — tidak ada logic
bisnis tambahan di lapisan lain.

**Action summary (maks 20, agregat per kategori — bukan daftar outlet)**:

| Priority | Kategori | Contoh action_type |
|---|---|---|
| P0 | data_quality | outlet_tanpa_id, trx_tanpa_id, trx_tidak_match_outlet, qris_status_unknown |
| P1 | aktivasi | qris_terbit_tanpa_transaksi |
| P2 | penerbitan | qris_belum_terbit, qris_perbaikan_data, qris_rejected |
| P3 | retensi | churn_dari_bulan_lalu (butuh bulan pembanding) |
| P4 | growth | top_performer_p90_revenue |

Setiap entri hanya muncul kalau count > 0 — kalau semua kondisi bersih, array
bisa kosong. Frontend (Prompt 2/3) tinggal me-render array ini, tidak perlu
menghitung ulang apapun.

## 9. Frontend (Prompt 2)

### Route & Menu
- Route: `/war-room/instaqris-command-center` → komponen `WarRoomInstaqrisCommandCenter`
  (`frontend/src/pages/WarRoomInstaqrisCommandCenter.jsx`), didaftarkan di `App.jsx`.
- Menu sidebar: **Winme & InstaQRIS → War Room → InstaQRIS Command Center**,
  diletakkan **paling atas** (sebelum "Instaqris - Analitik"), badge `CMD`
  warna `#7F77DD`. Accordion Winme & InstaQRIS auto-open untuk route ini
  (lihat `isWRIqCcPath` di `Sidebar.jsx`).
- Service API: `frontend/src/services/api.js` — `getInstaqrisCommandCenterMonths()`
  dan `getInstaqrisCommandCenterAnalytics(bulan)`. TIDAK di-cache (`withCache`)
  — sama pola dengan DM Control Tower/PA LPD/BUMDes, karena data multi-bulan
  dan butuh selalu fresh saat ganti bulan.

### Catatan penting — response shape asli vs deskripsi awal
Field di response backend **bernested di dalam `kpi`**
(`kpi.outlet.top_provinsi`, `kpi.outlet.top_kategori`, `kpi.qris_status`,
`kpi.growth`), BUKAN field top-level `top_regions`/`top_categories`/`qris_status`/`growth`
seperti draft awal. Frontend dibangun mengikuti **shape asli** dari Prompt 1
(lihat §4), dengan optional chaining (`?.`) di semua pembacaan field supaya
tidak crash kalau ada field yang null/undefined/hilang.

### Cara membaca Health Status
Badge di header: `healthy` → **Sehat** (hijau), `warning` → **Perlu Perhatian**
(kuning), `critical` → **Kritis** (merah). Jika `health.reasons[]` tidak kosong,
ditampilkan sebagai catatan singkat di bawah header — ini bukan alarm error,
hanya ringkasan alasan status.

### Cara membaca KPI
9 kartu KPI: Merchant Terdaftar, QRIS Terbit, QRIS Terbit Rate (+ growth badge),
Outlet Transaksi, Active Rate, Total Transaksi, Revenue/MDR (+ sub Margin),
Avg Revenue/Trx, Kualitas Data (jumlah issue, merah kalau > 0). Semua angka besar
diformat ribuan (`id-ID`), Rupiah disingkat (jt/M) untuk kartu, persentase 1 desimal.

### Cara membaca Funnel
3 tahap: Merchant Terdaftar → QRIS Terbit → Outlet Transaksi, dengan 2 rate:
"Dari merchant terdaftar ke QRIS terbit" dan "Dari QRIS terbit ke outlet transaksi".
Funnel ini TIDAK menunjukkan populasi yang sama persis dengan urutan proses riil
per outlet (lihat §5 — cakupan katalog outlet vs transaksi bisa berbeda), jadi
dibaca sebagai indikator rasio kesehatan, bukan jalur linear 1 outlet per outlet.

### Cara membaca Insight/Bottleneck
Maksimal 5 kartu, masing-masing area punya judul bisnis + severity (Tinggi/Sedang)
+ deskripsi dari backend (`detail`) + rekomendasi generik per area (ditambahkan
di frontend, backend belum kirim field rekomendasi untuk insight). Kalau kosong,
berarti tidak ada bottleneck yang terdeteksi bulan ini (bukan berarti data kosong).

### Cara membaca Action Summary
Kartu per kategori aksi (bukan daftar outlet!), diberi label prioritas sesuai
konvensi bisnis: P0 = Cek Data Quality, P1 = Dorong Aktivasi/Tx1, P2 = Bereskan
Penerbitan QRIS, P3 = Retention, P4 = Growth/Reward. Tiap kartu menampilkan count
+ rekomendasi teks dari backend. **Batasan MVP: belum ada drilldown ke daftar
outlet per kategori aksi** — untuk follow-up per outlet, tim masih perlu ke
halaman War Room InstaQRIS lain (Analitik/Penerbitan QRIS/Transaksi by Outlet)
atau menunggu Prompt selanjutnya kalau drilldown diminta.

### Catatan khusus `trx_tidak_match_outlet`
Item ini **sengaja TIDAK ditampilkan sebagai error fatal** meskipun angkanya
besar (~24 ribu di sample Juni 2026 — lihat §5). Copy yang ditampilkan:
"Transaksi Tidak Match dengan Katalog Outlet Bulan Ini" dengan catatan "Ini bisa
terjadi karena cakupan tabel transaksi lebih luas daripada katalog outlet pada
bulan tersebut. Perlu dicek sumber data, bukan berarti transaksi salah." —
severity mengikuti backend (`warning`, tidak pernah `critical` untuk check ini).

### Batasan MVP Frontend
- Belum ada drilldown outlet-level (sesuai batasan Prompt 2 — action_summary
  murni agregat).
- Build asli (`npm run build`) belum bisa dijalankan di komputer lokal (Node
  tidak terpasang) — hanya static check (bracket/JSX-tag balance) yang
  dilakukan. Build sungguhan perlu dijalankan di server saat approval deploy.
- Insight `recommendation` per area dan label `action_type`/`check` yang lebih
  manusiawi adalah **enrichment presentasi di frontend** (map area/kode →
  teks), bukan field yang dikirim backend — kalau backend menambah field baru
  seperti itu di masa depan, map ini bisa disederhanakan/dihapus.

## 10. Batasan & Rekomendasi Lanjutan (belum dikerjakan di Prompt 1)

- Tidak ada index khusus di `iq_raw_*` untuk kolom `bulan` atau ekspresi
  JSONB — untuk saat ini masih cukup cepat (~2-3 detik per request), tapi
  kalau data terus bertambah, pertimbangkan index (`bulan`) atau functional
  index di masa depan (perlu migration terpisah, di luar scope Prompt 1).
  Untuk mengurangi query berulang: pertimbangkan cache 5 menit di frontend
  (`services/api.js`) mengikuti pola War Room analytics lain, saat Prompt 2/3.
- Definisi "outlet terdaftar per bulan" (snapshot vs kumulatif) adalah
  **asumsi berbasis observasi data**, bukan konfirmasi resmi dari pemilik
  sheet — perlu divalidasi ke tim Winme/InstaQris kalau angka `total_outlet`
  terasa tidak sesuai ekspektasi bisnis.
- `qris_terbit_rate`/`qris_problem_rate` dihitung dari SELURUH baris
  `iq_raw_qris` bulan tsb, TIDAK difilter "hanya outlet yang sudah aktivasi"
  seperti di halaman legacy "Penerbitan QRIS" (`data-raw.js`
  `qrisAnalyticsHandler`) — sengaja dibuat lebih sederhana untuk MVP ini,
  jadi angkanya bisa berbeda dari halaman legacy tsb. Ini bukan bug, tapi
  perbedaan cakupan yang perlu diketahui.
