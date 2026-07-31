# Produk — War Room Payment Agent > Produk

## Tujuan
Marketing Decision Dashboard untuk performa PRODUK Payment Agent (bukan per
outlet) — MAT, TRX, REV, ARPT, ATPU, ARPU per produk, deviasi vs bulan
sebelumnya & bulan awal jendela, status/priority/segment, campaign priority
board, dan diagnosis penyebab penurunan (TRX/frequency/monetization). Domain
ini TERPISAH dari:
- `pa_produk_snapshot` / `pa_produk_totals` (`backend/src/routes/warroom.js`,
  legacy Apr/Mei/Jun hardcode kolom kalender).
- `warroom_pa_produk_periode` (rolling m2/m1/curr window, belum ada route aktif).

Jangan menyatukan atau menimpa ketiganya.

## Sumber Data
Google Sheet: `1GbDo9ASOQYiCCVqOT89RxAWuvZfQjeNbq3U9qP4jvcw`, tab **Produk**.

Layout sheet (per spesifikasi):
- Kolom `PRODUK` (contoh: `15. TIKET PESAWAT`).
- Grup bulan berurutan (misal Mei 2026 / Juni 2026 / Juli 2026), masing-masing
  6 sub-kolom: MAT, TRX, REV, ARPT, ATPU, ARPU.
- Grup deviasi (misal `DEV : MEI VS JUL`, `DEV : JUN VS JUL`), masing-masing
  6 sub-kolom yang sama, prefix `dev_`.
- Info `Day N` di area header (menunjukkan data MTD sampai hari ke-N).
- Baris `TOTAL` dipakai untuk validasi, TIDAK masuk sebagai produk.
- Angka dalam tanda kurung, contoh `(883,120,723)`, dibaca sebagai **negatif**.

## Bulan 100% Dinamis
Tidak ada nama bulan (Mei/Juni/Juli) yang di-hardcode di backend/Apps Script.
- Apps Script membaca label bulan langsung dari header sheet, sort ascending,
  lalu menandai: bulan **pertama** = baseline, bulan **terakhir** = current,
  bulan di antaranya = previous (khusus 3 bulan).
- Backend menyimpan role ini sebagai `current_month` / `previous_month` /
  `baseline_month` + label masing-masing di `meta` response `analytics`.
- **Deviasi dipetakan berdasarkan POSISI, bukan teks.** `compare_key` yang
  dikirim & disimpan selalu salah satu dari 2 nilai generik:
  - `baseline_vs_current` — grup deviasi PERTAMA di sheet.
  - `previous_vs_current` — grup deviasi KEDUA di sheet.

  `compare_label` tetap membawa teks asli header sheet (contoh
  `"DEV : MEI VS JUL"`) untuk audit/tampilan. Kalau label teks tidak
  cocok dengan bulan yang terdeteksi, Apps Script menambahkan
  `parse_warnings`: *"Deviation header tidak sepenuhnya sama dengan month
  header, mapping dilakukan berdasarkan posisi."*
- Semua label KPI/insight/chart di frontend memakai `current_month_label` /
  `previous_month_label` / `baseline_month_label` dari response backend —
  TIDAK ADA teks "Juli"/"Juni"/"Mei" hardcode di frontend.

## Fair MTD Comparison
Data bulan berjalan bersifat MTD (Month-to-Date) sampai hari ke-`day_number`.
Sheet sumber SUDAH menyamakan angka bulan-bulan sebelumnya sampai hari yang
sama (fair comparison) — dashboard menampilkan badge **"Fair MTD Comparison"**
dan tidak pernah menganggap bulan sebelumnya sebagai full-month.

## Database
Migration: `backend/src/migrations/create_payment_agent_produk.sql`
Runner: `backend/scripts/run-payment-agent-produk-migration.js`
Remote runner (SSH, safety-gated): `scripts/run_payment_agent_produk_migration_remote.py`

| Tabel | Key | Isi |
|---|---|---|
| `payment_agent_produk_metrics` | UNIQUE(snapshot_date, month_key, product_label) | mat/trx/rev/arpt/atpu/arpu per produk per bulan per snapshot harian |
| `payment_agent_produk_deviation` | UNIQUE(snapshot_date, compare_key, product_label) | dev_mat/trx/rev/arpt/atpu/arpu per produk per compare_key (`baseline_vs_current` / `previous_vs_current`) |
| `payment_agent_produk_sync_log` | id BIGSERIAL | riwayat sync (sukses/gagal, jumlah baris diterima/insert, metadata) |
| `payment_agent_produk_config` | UNIQUE(sync_key) | source_url, sheet_name, snapshot/day terakhir, month_list, source_meta |

`snapshot_date` = 1 baris per hari sync (data update harian) — histori
menumpuk, TIDAK ditimpa; sync hanya menghapus data untuk `snapshot_date` yang
sama persis (idempotent per hari, bukan per bulan).

## Backend Endpoints (`backend/src/routes/warroom-payment-agent-produk.js`)
Didaftarkan di `backend/src/app.js` SEBELUM catch-all `/api/warroom` (sync
endpoint bypass JWT, konsisten dengan war-room lain).

| Endpoint | Auth | Keterangan |
|---|---|---|
| `POST /api/warroom/payment-agent/produk/sync` | token `x-sync-token` / `Authorization: Bearer` / body `token`, dari ENV `PAYMENT_AGENT_PRODUK_SYNC_TOKEN` (TIDAK ADA fallback hardcode — 401 kalau env belum diset) | Replace-per-snapshot_date: hapus data lama HANYA untuk snapshot_date yang dikirim, insert ulang dalam 1 transaksi, rollback penuh kalau gagal |
| `GET /api/warroom/payment-agent/produk/snapshots` | JWT | Daftar snapshot tersedia `{snapshot_date, day_number, label, last_sync}` |
| `GET /api/warroom/payment-agent/produk/analytics?snapshot_date=latest` | JWT | meta (bulan dinamis), summary KPI, products[], top_products, campaign_priority, matrix 2x2, insights (maks 5), action_summary (maks 20), data_quality |
| `GET /api/warroom/payment-agent/produk/detail?snapshot_date=&product_name=` | JWT | Trend bulanan produk, deviasi, diagnosis, campaign recommendation, content angle |
| `GET /api/warroom/payment-agent/produk/table?snapshot_date=&page=&limit=&search=&status=&priority=&sort_by=&sort_dir=` | JWT | Versi paginated/sortable dari `products[]` analytics (opsional, dipakai untuk keperluan integrasi lain — frontend tab Product Ranking saat ini filter/sort di client karena jumlah produk kecil per snapshot) |

## Status / Priority / Segment Logic
Dihitung 100% di backend (`classifyProduct` di route file), frontend murni
presentasi.

**Status** (dibanding `previous_month`):
- `no_data` — produk tidak punya data bulan current.
- `kritis` — revenue bulan current ≤ 0.
- `turun` — growth revenue vs previous ≤ -5%.
- `naik` — growth revenue vs previous ≥ +5%.
- `stabil` — selain di atas.

**Priority**:
- `P0 Selamatkan Revenue` — kritis, atau turun & termasuk top-revenue (≥ P70 revenue produk aktif).
- `P1 Scale Produk Naik` — turun (non top-revenue, tetap perlu follow-up cepat), atau naik signifikan (≥10%).
- `P2 Perbaiki Frequency` — MAT relatif stabil (≥ -3%) tapi TRX atau ATPU turun (< -5%).
- `P3 Jaga Momentum` — stabil.
- `P4 Data Quality / Low Priority` — no_data.

**Segment**: Core Revenue Driver, Growth Product, Declining Product, High MAT
Low Revenue, Low MAT High ARPU, Frequency Problem, Monetization Problem, Low
Priority — cascade rule lihat `classifyProduct()`.

## Campaign Recommendation & Content Angle
Dihasilkan per produk di endpoint `/detail`, contoh:
- Revenue turun → win-back campaign, WA blast, cashback terbatas.
- Revenue naik → tambah exposure, bundling produk, campaign tanggal gajian.
- Diagnosis otomatis: "Revenue turun karena TRX turun.", "MAT stabil tapi
  TRX/ATPU turun, artinya frequency problem.", "ARPU turun, artinya
  monetization problem.", "Produk naik dan layak scale campaign."

## Data Quality Checks
formula_error_count, missing_product_name, invalid_mat/trx/rev/arpt/atpu/arpu,
duplicate_product, total_row_mismatch, negative_values_count,
month_data_missing, deviation_mismatch — semua tampil di tab Data Quality
dengan severity low/medium/high dan rekomendasi perbaikan.

## Apps Script (`apps-script-payment-agent-produk.js`)
Fungsi: `previewPaymentAgentProdukPayload()`, `pushPaymentAgentProdukSemua()`,
`setupPaymentAgentProdukTrigger()` (BELUM diaktifkan), `deletePaymentAgentProdukTriggers()`.

Parser men-scan header sheet secara dinamis (bukan hardcode row/kolom):
mencari baris subheader yang berisi MAT/TRX/REV, baris di atasnya dianggap
label grup (forward-fill untuk sel merge kosong), lalu memisahkan grup bulan
(label yang bisa di-parse jadi `YYYY-MM`) dari grup deviasi (sisanya, urutan
sheet = posisi baseline lalu previous).

Script Properties yang wajib diisi di Apps Script Editor (Project Settings):
- `PAYMENT_AGENT_PRODUK_SYNC_TOKEN` — harus identik dengan env server
- `PAYMENT_AGENT_PRODUK_SYNC_URL` — default `https://bmsretail.my.id/api/warroom/payment-agent/produk/sync` kalau dikosongkan

`safeNumber_`/`pap_safeNumber_` menangani: angka asli, "1,000"/"1.000" (pemisah
ribuan), "(883,120,723)" (negatif), "-", "", null, formula error
(`#NAME?`, `#DIV/0!`, dst → null + masuk `formula_error_count`).

**Trigger otomatis BELUM diaktifkan** — jalankan `setupPaymentAgentProdukTrigger()`
manual kapan pun siap (23:00 UTC / 06:00 WIB, konsisten dengan war-room lain).

## Frontend
- Route: `/war-room/payment-agent/produk` — `frontend/src/pages/WarRoomPaymentAgentProduk.jsx`
- Menu: **War Room Payment Agent → Produk** (badge `PROD`, warna `#0EA5E9`)
- Service API: `frontend/src/services/api.js` — `getPaymentAgentProdukSnapshots`,
  `getPaymentAgentProdukAnalytics`, `getPaymentAgentProdukDetail`, `getPaymentAgentProdukTable`
- CSS prefix: `pa-prod-*` (`frontend/src/index.css`), pakai `var(--token)` untuk
  semua warna supaya otomatis kontras di light & dark mode.

### 6 Tab
1. **Overview** — KPI (revenue/trx/mat current + ARPT/ATPU/ARPU + vs previous/baseline), growth summary, top products, insight marketing.
2. **Product Ranking** — tabel lengkap: search, filter status/priority/segment, sort per kolom, pagination 10/25/50/100, reset filter, export CSV, klik baris → detail.
3. **Growth & Decline** — perbandingan 3 bulan, ranking kenaikan/penurunan vs previous & baseline, filter (naik/turun/high revenue declining/growth product).
4. **Campaign Priority** — board 5 kolom P0–P4, tiap card: revenue, deviasi, diagnosis, rekomendasi.
5. **Product Deep Dive** — trend bulanan, deviasi per compare_key, diagnosis, campaign recommendation, content angle. Kosong sampai produk dipilih dari tab lain.
6. **Data Quality** — daftar check dengan severity & rekomendasi, catatan angka kurung = negatif, warning kalau ada mismatch row TOTAL.

## Deploy / Sync Steps
1. `node backend/scripts/run-payment-agent-produk-migration.js` (lokal, kalau
   ada akses `DATABASE_URL` langsung) ATAU
   `python scripts/run_payment_agent_produk_migration_remote.py` (via SSH ke
   VPS, minta konfirmasi ketik `MIGRATE` — safety gate, tidak bisa di-skip).
2. Set env `PAYMENT_AGENT_PRODUK_SYNC_TOKEN` di `backend/.env` server (token
   acak, TIDAK sama dengan token war-room lain demi isolasi blast-radius).
3. Deploy kode (frontend+backend) via `scripts/safe_deploy.py --execute`
   (minta konfirmasi ketik `DEPLOY`).
4. Copy `apps-script-payment-agent-produk.js` ke Apps Script Editor pada
   spreadsheet sumber, isi Script Properties (lihat di atas).
5. Jalankan `previewPaymentAgentProdukPayload()`, cek log (metric rows > 0,
   deviation rows > 0, months ≥ 2, day_number & snapshot_date benar, sample
   mapping masuk akal, angka kurung jadi negatif).
6. Kalau preview OK, jalankan `pushPaymentAgentProdukSemua()` SATU KALI.
7. Validasi: `GET /snapshots`, `GET /analytics?snapshot_date=latest`,
   `GET /detail?...` dengan token JWT valid; buka
   `https://bmsretail.my.id/war-room/payment-agent/produk` dan cek 6 tab.

## Troubleshooting
- **metric/deviation rows = 0 di preview** → cek label header grup bulan
  (harus `<NAMA_BULAN> <TAHUN>`, contoh "Mei 2026") dan pastikan baris
  subheader mengandung teks MAT/TRX/REV persis (case-insensitive, tanpa
  spasi ekstra yang tidak wajar).
- **Sync 401** → `PAYMENT_AGENT_PRODUK_SYNC_TOKEN` belum diset di server atau
  tidak sama dengan Script Property di Apps Script.
- **Sync 413/timeout dari Nginx** → payload harian Produk biasanya kecil
  (puluhan produk x beberapa bulan), tapi kalau tetap terjadi, endpoint sync
  ini perlu ditambahkan ke regex body-besar di `nginx-bric.conf` — JANGAN
  ubah Nginx tanpa konfirmasi eksplisit, laporkan dulu.
- **Angka aneh (100x lipat)** → cek `pap_safeNumber_`/`safeNumber` sudah
  menangani `typeof v === 'number'` sebelum string processing (insiden
  Speedcash lama, lihat CLAUDE.md §5).
- **Bulan tidak berubah otomatis bulan depan** → pastikan Apps Script
  benar-benar membaca label header sheet (bukan cache lama); cek
  `parse_warnings` di response sync/preview.
