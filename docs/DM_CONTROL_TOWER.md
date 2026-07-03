# DM Control Tower — Dokumentasi (Prompt 1, 2 & 3: Backend, Apps Script, Frontend)

Status: **Prompt 1 (backend & database), Prompt 2 (Google Apps Script sync),
dan Prompt 3 (patch config bulan + frontend dashboard) semuanya sudah
dibuat.** Belum ada deploy ke production, belum ada migration yang
dijalankan ke database production, dan belum ada sync sungguhan ke
production — semuanya menunggu persetujuan eksplisit pemilik produk (lihat
Bagian 14 "Checklist Deploy — Tunggu Persetujuan").

## 1. Tujuan Fitur

DM Control Tower adalah dashboard monitoring corong (funnel) DM: dari
registrasi outlet → aktivasi → transaksi pertama → repeat, multi-bulan.
Sumbernya Google Sheet yang sama dipakai berulang tiap bulan (bukan sheet
baru tiap bulan) — user replace 3 sheet raw, lalu sync ke BRIC dengan
parameter bulan.

**Prinsip utama**: semua angka (funnel, cohort H0-H3, segmentasi outlet,
data quality) dihitung di **backend BRIC dari data mentah**, BUKAN dengan
mengambil hasil formula dari Google Sheet. Ini supaya definisi metric
konsisten, bisa diaudit, dan tidak tergantung formula sheet yang bisa
berubah sewaktu-waktu.

## 2. Konsep Multi-Bulan

- Google Sheet sumber tetap sama terus (tidak buat sheet baru tiap bulan).
- Tiap bulan, user replace isi 3 sheet raw: Register, Aktivasi, Transaksi.
- Sync ke BRIC dengan parameter `bulan=YYYY-MM` (contoh: `2026-06`, `2026-07`).
- **Sync 1 bulan HANYA mengganti data bulan itu** di tabel terkait —
  data bulan lain tidak pernah ikut terhapus/berubah. Ini dijamin oleh pola
  `DELETE FROM tabel WHERE bulan=$1` (scoped ke 1 bulan) diikuti `INSERT`
  ulang, dibungkus 1 transaksi database supaya tidak ada kondisi data
  "sudah kehapus tapi belum ke-insert ulang" kalau proses gagal di tengah.

## 3. Tabel Database

Semua tabel baru, dibuat lewat `backend/src/migrations/create_dm_control_tower.sql`.

### `dm_ct_raw_register`
1 baris per outlet per bulan.
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | SERIAL PK | |
| bulan | TEXT | format YYYY-MM |
| id_outlet | TEXT | |
| tanggal_register | DATE | nullable (null kalau gagal parse) |
| row_data | JSONB | baris mentah asli dari sheet, utuh |
| synced_at | TIMESTAMPTZ | |
| — | UNIQUE(bulan, id_outlet) | |

### `dm_ct_raw_aktivasi`
Sama strukturnya dengan register, kolom tanggal bernama `tanggal_aktivasi`.

### `dm_ct_raw_trx`
BANYAK baris per outlet per bulan (1 outlet bisa transaksi berkali-kali).
| Kolom | Tipe | Keterangan |
|---|---|---|
| id | SERIAL PK | |
| bulan | TEXT | |
| id_outlet | TEXT | |
| tanggal_transaksi | DATE | nullable |
| trx_count | NUMERIC | |
| margin | NUMERIC | |
| row_hash | TEXT | hash md5 dari isi baris (stabil, tidak peduli urutan kolom) |
| row_data | JSONB | baris mentah asli, utuh |
| synced_at | TIMESTAMPTZ | |
| — | UNIQUE(bulan, row_hash) | **BUKAN** unique per id_outlet — 1 outlet boleh banyak baris |

### `dm_ct_sync_log`
Riwayat setiap kali sync dijalankan (audit trail), 1 baris per panggilan sync.
| Kolom | Tipe |
|---|---|
| bulan, source_type | TEXT |
| rows_received, rows_inserted, rows_skipped | INT |
| status | TEXT ("success"/"error") |
| error_message | TEXT |
| synced_at | TIMESTAMPTZ |

Semua tabel punya index untuk `bulan`, `id_outlet`, kolom tanggal, dan
index GIN untuk `row_data` (jaga-jaga kalau nanti perlu query ke dalam JSON).

### `dm_ct_month_config` (Prompt 3)
Source of truth untuk `period_start`/`period_end`/`mature_cohort_end` per
bulan — lihat penjelasan lengkap "kenapa ini penting" di Bagian 6.
| Kolom | Tipe | Keterangan |
|---|---|---|
| bulan | TEXT PK | format YYYY-MM |
| period_start | DATE | nullable |
| period_end | DATE | nullable |
| mature_cohort_end | DATE | nullable |
| source_config | JSONB | echo mentah field yang dikirim payload sync (untuk audit) |
| updated_at | TIMESTAMPTZ | terakhir kali di-upsert |

Diisi otomatis oleh ketiga endpoint sync (register/aktivasi/trx) kalau
payload menyertakan `period_start`/`period_end`/`mature_cohort_end` (Apps
Script Prompt 2 sudah mengirim ini dari sheet `01_CONFIG`). Upsert per-field
(pakai `COALESCE`) — payload yang cuma mengisi sebagian field TIDAK menimpa
field lain yang sudah tersimpan benar jadi NULL.

## 4. Endpoint Backend

Prefix: `/api/warroom/dm-control-tower`

### Sync (token auth, BUKAN JWT — dipanggil Google Apps Script, lihat Bagian 11)
| Method | Path | Body |
|---|---|---|
| POST | `/register/sync` | `{ token, bulan, sheet_name?, replace_mode?, chunk_index?, chunk_total?, rows[] }` |
| POST | `/aktivasi/sync` | sama |
| POST | `/trx/sync` | sama |

Token bisa dikirim lewat header `x-sync-token`, header `Authorization: Bearer <token>`,
atau field `token` di body — backend menerima ketiganya. Token dicocokkan
dengan `process.env.APPS_SCRIPT_TOKEN` (**wajib di-set di server, tidak ada
nilai cadangan tertulis di kode** — beda dari kebiasaan lama).

**Chunk safety (ditambahkan Prompt 2)**: `replace_mode` boleh `"replace"`
atau `"append"`, default `"replace"` kalau tidak dikirim (backward compatible
dengan 1x-request tanpa chunking). Hanya request `replace_mode: "replace"`
yang menjalankan `DELETE WHERE bulan=$1` sebelum insert; `"append"` hanya
insert/upsert. Ini WAJIB dipakai kalau 1 sumber data dikirim dalam beberapa
request (chunk pertama = `replace`, chunk berikutnya = `append`), supaya
chunk terakhir tidak menghapus hasil insert chunk-chunk sebelumnya.
`chunk_index`/`chunk_total` opsional, hanya untuk logging. `period_start`/
`period_end`/`mature_cohort_end` juga opsional, TAPI **kalau dikirim, akan
disimpan sebagai config bulan resmi** (tabel `dm_ct_month_config`) dan
DIPAKAI oleh analytics — lihat Bagian 6 "Mature Cohort End Mengikuti
Config" (keputusan bisnis final Prompt 3, menggantikan perilaku Prompt 1
yang selalu menghitung sendiri dari kalender).

### Analytics (wajib login/JWT)
| Method | Path | Keterangan |
|---|---|---|
| GET | `/months` | daftar bulan yang sudah pernah sync + jumlah baris + waktu sync terakhir |
| GET | `/analytics?bulan=YYYY-MM` | ringkasan lengkap (lihat struktur respons di bawah) |
| GET | `/data-quality?bulan=YYYY-MM` | daftar masalah kualitas data, dengan contoh baris |
| GET | `/outlets?bulan=&page=&limit=&search=&segment=` | daftar outlet per halaman (server-side pagination) |

## 5. Struktur Respons `GET .../analytics`

```json
{
  "meta": { "bulan", "period_start", "period_end", "mature_cohort_end", "last_sync" },
  "summary": { "total_registrasi", "total_aktivasi", "activation_rate", "total_outlet_transaksi",
               "total_transaksi", "total_margin", "avg_margin_per_trx", "reg_to_tx1_h0_h3",
               "valid_akt_to_tx1", "early_repeat_rate", "handoff_farming", "handoff_rate",
               "data_quality_issues", "..." },
  "funnel": { "registrasi", "aktivasi", "tx1_h0_h3", "repeat_h0_h3" },
  "calendar_daily": [ { "tanggal", "registrasi", "aktivasi", "outlet_transaksi", "total_trx", "total_margin" } ],
  "cohort_daily": [ { "cohort_date", "total_registrasi", "aktivasi_h3", "tx1_h3", "repeat_h3", "trx_h3", "margin_h3" } ],
  "h03_activity": [ { "day_offset" (0-3), "outlet_count", "trx_rows", "total_trx", "total_margin" } ],
  "data_quality": [ { "check_type", "description", "count" } ],
  "segment_counts": [ { "segment", "count" } ],
  "action_queue": [ ...maks 300 baris, terurut P0->P3... ],
  "top_margin_outlets": [ ...maks 20... ],
  "top_repeat_outlets": [ ...maks 20... ]
}
```

Performa: `outlets` wajib dipanggil dengan pagination (maks 200/halaman),
`action_queue` dibatasi 300, contoh baris `data_quality` dibatasi 50-200 —
tidak pernah mengirim puluhan ribu outlet sekaligus dalam 1 respons.

## 6. Definisi Metric & Segmentasi (DIKONFIRMASI FINAL oleh pemilik produk)

- **H_Reg** = tanggal transaksi pertama outlet − tanggal register (hari).
- **H_Akt** = tanggal transaksi pertama outlet − tanggal aktivasi (hari).
- **H0-H3** = rentang 0 sampai 3 hari.
- **Mature cohort** = outlet yang tanggal register-nya ≤ `mature_cohort_end`
  bulan tsb (lihat sub-bagian di bawah untuk cara `mature_cohort_end`
  ditentukan).

### Mature Cohort End Mengikuti Config (keputusan bisnis final, Prompt 3)

`mature_cohort_end` (dan `period_start`/`period_end`) sekarang **mengikuti
tabel `dm_ct_month_config`**, diisi dari field yang sama di payload sync
(Apps Script Prompt 2 membacanya dari sheet `01_CONFIG`). Fallback ke
kalender murni (akhir bulan − 3 hari) **HANYA** dipakai kalau config bulan
itu belum ada / field-nya kosong.

**Kenapa ini penting untuk bulan berjalan**: kalau bulan belum selesai
(mis. Juli baru berjalan sampai tanggal 15), memakai "akhir kalender bulan
− 3 hari" akan salah total — misalnya jadi tanggal 28 padahal data
transaksi baru ada sampai tanggal 15. Dengan `mature_cohort_end` dari
config (yang dihitung sheet dari tanggal data yang **benar-benar ada**,
mis. `max_transaction_date - 3 hari`), outlet yang cohort-nya belum
benar-benar bisa dinilai (karena window H0-H3-nya belum lewat berdasarkan
data yang tersedia) tidak akan salah diklasifikasikan sebagai
`handoff_farming` sebelum waktunya.

Contoh nyata yang ditemukan saat Prompt 3 dibangun (dicek read-only dari
sheet produksi, tanpa sync sungguhan): untuk bulan `2026-06`, sheet
`01_CONFIG` punya `Mature Cohort End = 2026-06-29` (dihitung dari `Max
Transaction Date 2026-07-02 − 3 hari`), BUKAN `2026-06-27` (hasil hitung
kalender murni Prompt 1). Backend sekarang memakai `2026-06-29` begitu
config tersimpan, bukan `2026-06-27`.

`GET .../analytics` menampilkan hasil resolusi ini di `meta.config_source`:
- `"config"` — semua 3 field (period_start/period_end/mature_cohort_end)
  berasal dari `dm_ct_month_config` (data sinkronisasi Apps Script).
- `"partial"` — sebagian field dari config, sebagian fallback kalender.
- `"fallback"` — belum ada config untuk bulan ini, semua dari kalender.

Frontend menampilkan ini secara sederhana (non-teknis) sebagai badge
"Berdasarkan data sinkronisasi" (config/partial) atau "Estimasi (belum ada
data config)" (fallback) — lihat Bagian 13.

**8 segmen outlet** (1 outlet hanya masuk 1 segmen, dievaluasi berurutan
sebagai cascade — definisi final, sudah dikonfirmasi pemilik produk):

| Segmen | Kondisi |
|---|---|
| `anomaly` | Ada masalah kualitas data — transaksi tercatat SEBELUM tanggal register/aktivasi |
| `tx1_h0_h3` | Transaksi PERTAMA terjadi dalam H0-H3 sejak tanggal registrasi |
| `repeat_h0_h3` | Outlet punya MINIMAL 2 transaksi dalam H0-H3 sejak tanggal registrasi |
| `late_tx` | Transaksi pertama terjadi SETELAH H3, tapi cohort belum matang (kasus langka/edge-case, lihat catatan di bawah) |
| `active_after_handoff` | Outlet yang gagal Tx1 di H0-H3 (cohort sudah matang), TAPI akhirnya bertransaksi juga setelah H3 |
| `handoff_farming` | **METRIC BISNIS UTAMA.** Registrasi sudah lewat H3 (cohort matang) TAPI belum berhasil Tx1 sama sekali — outlet ini yang perlu dilempar ke tim farming |
| `activated_no_tx` | Sudah aktivasi, tapi belum pernah transaksi (cohort belum matang) |
| `registered_only` | Sudah registrasi, belum aktivasi, dan belum transaksi (cohort belum matang) |

> **Catatan penting**: `handoff_farming` BUKAN segmen sehat/sukses — ini
> justru sinyal masalah (outlet yang gagal onboarding, gagal Tx1 sama
> sekali padahal cohort-nya sudah matang) yang harus ditindaklanjuti tim
> farming. Pada draf awal Prompt 1, segmen ini sempat salah diimplementasikan
> sebagai kebalikannya (dianggap "sudah repeat & sehat") — sudah diperbaiki
> di seluruh backend (SQL cascade, priority mapping, ringkasan analytics)
> agar konsisten dengan definisi final ini.
>
> **Catatan `late_tx` vs `active_after_handoff`**: keduanya sama-sama
> berarti "transaksi pertama terjadi setelah H3", bedanya status kematangan
> cohort. Kalau cohort sudah matang → `active_after_handoff` (sempat jadi
> kandidat handoff, lalu akhirnya convert). Kalau cohort belum matang tapi
> entah bagaimana sudah ada transaksi >H3 di bulan yang sama → `late_tx`.
> Karena data transaksi di-scope per bulan sync, kombinasi ini sangat jarang
> terjadi dalam praktik — `late_tx` tetap disediakan sebagai jaring
> pengaman/sinyal kualitas data, bukan segmen populasi besar.

**Priority Action Queue** (P0 = paling urgent, final):
| Priority | Segmen |
|---|---|
| P0 | `anomaly` (masalah kualitas data) |
| P1 | `activated_no_tx` (eksplisit), `handoff_farming` (metric bisnis utama) |
| P2 | `registered_only` (eksplisit), `late_tx` |
| P3 | `tx1_h0_h3`, `repeat_h0_h3`, `active_after_handoff` (semua sehat) |

> Penempatan P0-P3 untuk `registered_only`, `activated_no_tx`, dan grup
> "sehat" (P3) sudah eksplisit dari pemilik produk. Yang masih inferensi
> saya (bukan disebut eksplisit, mohon dikonfirmasi kalau maunya beda):
> **`handoff_farming` di P1** — karena disebut sebagai "metric bisnis utama"
> yang butuh eskalasi segera ke farming, dan **`late_tx` di P2** — karena
> ini kasus langka dengan prioritas menengah (outlet akhirnya tetap
> bertransaksi, walau telat).

## 7. Data Quality — Jenis Pengecekan

`duplicate_register`, `duplicate_aktivasi` (secara teori selalu 0, dijaga
oleh UNIQUE constraint di database), `duplicate_outlet_date_trx`,
`trx_before_register`, `trx_before_aktivasi`, `trx_outlet_tidak_ada_di_register`,
`trx_outlet_tidak_ada_di_aktivasi`, `aktivasi_tanpa_register`,
`register_tanpa_aktivasi`, `aktivasi_tanpa_transaksi`, `id_outlet_kosong`
(dicegah saat sync, dilaporkan lewat `rows_skipped`), `tanggal_invalid`
(baris tersimpan dengan tanggal NULL, bukan error).

## 8. Field Parser Fleksibel

Header kolom di sheet boleh bervariasi (spasi/underscore/huruf besar-kecil
bebas) — backend mencocokkan berdasarkan nama yang dinormalisasi. Kandidat
nama yang dikenali untuk tiap field ada di `warroom-dm-control-tower.js`
(konstanta `ID_OUTLET_CANDIDATES`, `TANGGAL_REGISTER_CANDIDATES`, dst.).

**Update Prompt 2** (setelah header sheet produksi asli dicek): daftar
kandidat awal di Prompt 1 tidak cocok dengan 2 header nyata di sheet, sudah
ditambahkan:
- `04_RAW_AKTIVASI_DIRECT` pakai header **`tanggal_aktifasi`** (ejaan dengan
  huruf F) — bukan `tanggal_aktivasi`.
- `02_RAW_TRX_DIRECT` pakai header **`achieve_trx`** (jumlah transaksi) dan
  **`achieve_rev`** (margin/omzet, format `"Rp 98,484"`) — bukan `trx`/`margin`.

Tanpa perbaikan ini, seluruh baris aktivasi tersimpan dengan
`tanggal_aktivasi = NULL`, dan seluruh baris transaksi tersimpan dengan
`trx_count = 0` dan `margin = 0` — data korup total tapi tidak error (silent
failure). Kalau nama-nama kolom ini berubah lagi di kemudian hari, tambahkan
variannya ke konstanta terkait, dan/atau perhatikan peringatan
`logFieldCoverage` di log Apps Script (Bagian 11) yang dirancang untuk
mendeteksi dini kasus seperti ini.

Parser tanggal menerima: ISO string (dengan/tanpa waktu), `DD/MM/YYYY`, dan
Date object langsung. Parser angka (`cleanNum`) WAJIB cek `typeof number`
dulu sebelum memperlakukan sebagai string — mengikuti aturan yang sudah
didokumentasikan di `CLAUDE.md` supaya tidak mengulang bug lama (angka
desimal yang titiknya kehapus jadi 100x lebih besar).

## 9. Cara Menjalankan Migration dengan AMAN (nanti, bukan sekarang)

**JANGAN dijalankan ke production sebelum direview & disetujui.** Kalau
sudah siap, jalankan lewat mekanisme yang sama seperti fitur War-Room lain
(lihat `docs/DEPLOYMENT_SAFETY.md`):

1. **Backup database dulu**: `python scripts/backup_db.py`
2. Kirim file migration ke server (lewat proses deploy yang sudah ada,
   BUKAN dijalankan manual tanpa backup).
3. Di server, jalankan migration runner:
   ```
   node backend/scripts/run-dm-control-tower-migration.js
   ```
   Script ini idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`)
   — aman dijalankan berkali-kali, tidak akan menghapus data yang sudah ada.
   File migration sudah diperbarui di Prompt 3 untuk menyertakan tabel
   `dm_ct_month_config` (belum pernah dijalankan ke production sama sekali,
   jadi aman diupdate langsung tanpa migration tambahan/terpisah).
4. Verifikasi tabel baru muncul, baru lanjut deploy backend (restart PM2
   lewat `sudo -u admin pm2 reload bric-backend`, TIDAK PERNAH `pkill`).

## 10. Catatan Nginx (belum diubah, hanya rekomendasi)

Endpoint sync (`/register/sync`, `/aktivasi/sync`, `/trx/sync`) berpotensi
menerima payload besar kalau jumlah baris raw per bulan banyak (ribuan
transaksi). **Nginx BELUM diubah** sesuai instruksi Prompt 1, tapi kalau
nanti ternyata payload > 1-2MB, regex whitelist body besar di
`nginx-bric.conf` perlu ditambah 3 path baru ini, mengikuti pola yang
sudah ada untuk war-room lain:

```
^/api/(warroom/(...|dm-control-tower/(register|aktivasi|trx))|data-raw/(...))/sync$
```

Ini baru rekomendasi — perlu dikerjakan terpisah, dengan hati-hati, dan
tidak dilakukan sebagai bagian dari Prompt 1.

## 11. Apps Script — Cara Pasang & Sync Manual (Prompt 2, SUDAH DIBUAT)

File: `apps-script-dm-control-tower.js` (di root repo, di-copy-paste manual ke
Google Apps Script Editor — bukan dijalankan dari repo, sama seperti semua
`apps-script-*.js` lain di project ini).

**Cara pasang:**
1. Buka Google Sheet DM Control Tower (workbook yang berisi `01_CONFIG`,
   `03_RAW_REGISTER_DIRECT`, `04_RAW_AKTIVASI_DIRECT`, `02_RAW_TRX_DIRECT`).
2. Menu **Extensions > Apps Script**.
3. Buat file script baru, beri nama bebas (mis. `DmControlTowerSync`), lalu
   tempel seluruh isi `apps-script-dm-control-tower.js`.
4. **Isi token lewat Script Properties** (bukan ditulis di kode):
   - Klik ikon gerigi **Project Settings** di sidebar kiri Apps Script Editor.
   - Scroll ke bagian **Script Properties** > **Add script property**.
   - Property: `SYNC_TOKEN`, Value: token asli (sama dengan env
     `APPS_SCRIPT_TOKEN` di server — TANYAKAN ke yang memegang akses server,
     JANGAN pernah tulis token asli ini di dokumentasi, screenshot, atau chat).
   - Klik **Save script properties**.
   - Kalau property ini belum diisi, semua fungsi sync akan berhenti dengan
     pesan error jelas ("SYNC_TOKEN belum diisi...") — tidak pernah mencoba
     sync dengan token kosong.
5. Simpan kode (Ctrl+S / ikon disket).

**Cara sync manual (Juni pertama kali / bulan mana pun):**
1. Pastikan sheet `01_CONFIG` sudah berisi baris `Bulan` dengan nilai bulan
   yang benar (format `YYYY-MM`, mis. `2026-06`), dan 3 sheet raw sudah diisi
   data bulan tsb.
2. Di Apps Script Editor, pilih fungsi `pushDmControlTowerSemua` dari dropdown
   fungsi di toolbar, lalu klik **Run**.
3. Google akan minta izin akses (`UrlFetchApp` ke domain luar) — setujui izin
   ini sekali di awal (klik akun Google yang sesuai, "Advanced" > "Go to
   project (unsafe)" kalau muncul peringatan, ini normal untuk script pribadi).
4. Buka **Executions** (ikon jam di sidebar kiri) atau **View > Logs** untuk
   melihat hasil: jumlah baris dibaca/dikirim per sheet, jumlah chunk, status
   HTTP tiap chunk, dan ringkasan akhir.
5. Kalau ingin sync 1 sumber saja (mis. baru betulkan sheet transaksi), jalankan
   `pushDmControlTowerTrx` (atau `pushDmControlTowerRegister` /
   `pushDmControlTowerAktivasi`) secara terpisah — tidak perlu jalankan semua.

**Cara update data bulan baru (mis. Juli menyusul Juni):**
1. Update sheet `01_CONFIG`: ubah baris `Bulan` jadi `2026-07`, serta
   `Period Start`/`Period End`/`Mature Cohort End` sesuai data Juli
   (sheet ini sudah menghitungnya secara dinamis berdasarkan data yang ada).
2. Replace/timpa isi 3 sheet raw (`03_RAW_REGISTER_DIRECT` dst.) dengan data
   Juli — **TIDAK PERLU** membuat sheet baru per bulan (workbook ini didesain
   dipakai ulang tiap bulan, beda dari beberapa War Room lain yang pakai 1 tab
   per bulan).
3. Jalankan `pushDmControlTowerSemua()` lagi. Karena backend sync scoped per
   `bulan`, data Juni yang sudah tersimpan (bulan `2026-06`) TIDAK ikut
   terhapus/berubah — hanya bulan `2026-07` yang di-replace.

**Cara setup trigger otomatis (nanti, JANGAN dijalankan sekarang):**
- Fungsi `setupDmControlTowerTrigger()` sudah disediakan (trigger harian jam
  23:00 UTC / 06:00 WIB), tapi **sengaja tidak dipanggil otomatis**.
- Jalankan fungsi ini secara manual dari Apps Script Editor HANYA setelah
  dashboard (frontend Prompt 3) sudah ada dan sync manual sudah diverifikasi
  menghasilkan data yang benar di database selama beberapa kali percobaan.
- Sebelum itu, sync tetap dilakukan manual (klik Run) tiap kali data sheet
  di-update.

**Catatan — JANGAN ubah header raw sheet sembarangan:**
Backend mencocokkan kolom berdasarkan nama header (lihat Bagian 8). Mengubah/
mengganti nama kolom di `03_RAW_REGISTER_DIRECT` / `04_RAW_AKTIVASI_DIRECT` /
`02_RAW_TRX_DIRECT` (mis. rename `achieve_trx` jadi nama lain) bisa membuat
backend gagal mengenali kolom itu lagi — data akan tersimpan dengan
tanggal/angka kosong TANPA error yang jelas ke user. Skrip Apps Script sudah
menyertakan pengecekan otomatis (`logFieldCoverage`) yang akan menulis
**PERINGATAN** di log kalau lebih dari 10% baris kehilangan nilai di kolom
tanggal/angka utama — selalu cek log ini setelah sync, terutama setelah ada
perubahan struktur sheet.

**Catatan chunk / payload besar:**
- Ukuran chunk saat ini `CHUNK_SIZE = 4000` baris per request (di rentang
  rekomendasi 3000-5000). Kalau data 1 bulan membesar jauh melebihi ini
  (puluhan ribu baris) dan request mulai gagal/timeout, turunkan `CHUNK_SIZE`
  di Apps Script — backend sudah aman menerima berapa pun jumlah chunk karena
  mekanisme `replace_mode` (lihat Bagian 4 & catatan di atas file
  `warroom-dm-control-tower.js`).
- Endpoint sync **belum** masuk whitelist body besar di Nginx (lihat Bagian
  10) — kalau ke depannya chunk sebesar ini mulai ditolak Nginx (HTTP 413 atau
  connection reset), itu tandanya regex Nginx perlu ditambah. Ini BUKAN
  dikerjakan otomatis, perlu keputusan & aksi terpisah.

## 12. Riwayat Urutan Prompt

Rencana awal Prompt 1 menulis "Prompt 2 = frontend, Prompt 3 = Apps
Script" — pemilik produk kemudian membalik urutan ini (Prompt 2 = Apps
Script dulu, Prompt 3 = patch config bulan + frontend), karena Apps Script
perlu dites/diverifikasi datanya benar dulu sebelum ada UI yang
menampilkannya. Ketiga prompt (backend, Apps Script, frontend) sekarang
semuanya sudah selesai dibuat — yang tersisa hanya tahap approval &
eksekusi (migration, deploy, sync pertama), lihat Bagian 14.

## 13. Frontend — Halaman Dashboard (Prompt 3, SUDAH DIBUAT)

File: `frontend/src/pages/WarRoomDmControlTower.jsx`, route
`/war-room/dm-control-tower`, menu sidebar "DM Control Tower" (badge "DM
CT", warna `#7F77DD`) di bagian Payment Agent → War Room, tepat di bawah
"DM Fastpay" (fitur berbeda, tidak dihapus/diubah). Class CSS pakai prefix
baru `dmct-*` di `frontend/src/index.css`, tidak menimpa/reuse class page
lain.

**6 tab**:
1. **Overview** — KPI card (Registrasi, Activation Rate, Tx1 H0-H3, Early
   Repeat Rate, Handoff Farming, Margin H0-H3, Total Margin, Data Quality
   Issue), funnel 5-langkah (Registrasi → Aktivasi → Tx1 H0-H3 → Repeat
   H0-H3 → Handoff Farming), chart harian (Registrasi/Aktivasi/Outlet
   Transaksi).
2. **Cohort H0-H3** — tabel per tanggal registrasi: aktivasi ≤H3, Tx1 ≤H3,
   repeat ≤H3, margin H0-H3, conversion rate.
3. **Segmentasi** — kartu jumlah per 8 segmen + chart bar horizontal.
4. **Data Quality** — daftar isu (severity tinggi/sedang/rendah/info —
   lihat catatan di bawah), deskripsi, rekomendasi, contoh id_outlet.
5. **Action Queue** — tabel P0-P3, alasan & rekomendasi per segmen,
   tautan WhatsApp (kondisional, lihat catatan keterbatasan di bawah).
6. **Outlet Detail** — tabel server-side pagination (limit 100), search
   id_outlet, filter segmen, export CSV (halaman yang sedang tampil saja).

**Cara membaca KPI**: semua angka mengikuti definisi final di Bagian 6 —
"Handoff Farming" BUKAN metric sehat, kartunya sengaja ditandai merah kalau
> 0 karena ini yang paling butuh tindakan tim farming.

**Cara memilih bulan**: dropdown di kanan atas hero, terisi otomatis dari
`GET .../months`, default bulan terbaru (`months[0]`, sudah terurut DESC
dari backend). Kalau belum ada data sama sekali, halaman menampilkan pesan
"Belum ada data DM Control Tower. Jalankan sync dari Google Sheet terlebih
dahulu."

**Cara membaca mature cohort end**: ditampilkan sebagai catatan sederhana
di bawah hero: *"Cohort mature dihitung sampai tanggal yang sudah punya
window H0-H3 lengkap: [tanggal]"*, disertai badge kecil "Berdasarkan data
sinkronisasi" (kalau ada config dari Apps Script) atau "Estimasi (belum ada
data config)" (fallback kalender) — lihat Bagian 6 untuk penjelasan teknis
lengkapnya.

**Cara membaca Data Quality**: setiap isu punya badge severity (Tinggi/
Sedang/Rendah/Info) dan rekomendasi singkat. **Catatan jujur**: severity &
rekomendasi ini adalah heuristik tampilan FRONTEND SAJA (di
`WarRoomDmControlTower.jsx`, konstanta `DQ_META`) — backend Prompt 1/2/3
belum mengirim field severity/rekomendasi resmi, jadi kalau perlu diubah
kategorinya, tidak perlu ubah backend, cukup ubah `DQ_META` di frontend.

**Cara membaca Action Queue**: kolom "Alasan" & "Rekomendasi" juga
disusun di frontend berdasarkan segmen (`SEGMENT_META`), bukan dihitung
ulang di backend — backend hanya mengirim segmen/priority yang sudah
final, frontend cuma menerjemahkan ke kalimat manusiawi.

**Keterbatasan yang diketahui — tombol WhatsApp**: kolom "WhatsApp" di
Action Queue akan selalu menampilkan "no. HP belum tersedia" untuk saat
ini, karena endpoint `analytics`/`outlets` TIDAK mengirim nomor HP outlet
(hanya kolom hasil kalkulasi: id_outlet, segment, priority, tanggal,
total_trx, total_margin — lihat Bagian 5). Nomor HP kemungkinan ada di
`row_data` mentah (tersimpan di `dm_ct_raw_register`/`dm_ct_raw_aktivasi`)
tapi belum pernah diekspos lewat API manapun. Ini SENGAJA tidak diubah di
Prompt 3 karena di luar scope patch Bagian A (config bulan) dan berisiko
membesarkan ukuran respons `outlets`/`action_queue` (JSONB per outlet).
Kalau fitur WhatsApp ini mau benar-benar aktif, perlu perubahan backend
terpisah (expose kolom no. HP tertentu saja dari `row_data`, bukan seluruh
JSONB) — mohon didiskusikan dulu sebelum dikerjakan.

**Cara sync bulan baru secara ringkas** (detail lengkap di Bagian 11):
isi/replace 3 sheet raw + update `01_CONFIG` di Google Sheet → jalankan
`pushDmControlTowerSemua()` di Apps Script Editor → refresh halaman
`/war-room/dm-control-tower` → pilih bulan baru dari dropdown.

## 14. Checklist Deploy — Tunggu Persetujuan

Semua langkah di bawah **DISIAPKAN, TIDAK DIJALANKAN**. Urutan aman
(jangan lompat urutan), masing-masing butuh persetujuan eksplisit terpisah:

1. **Backup database dulu** — `python scripts/backup_db.py` (lihat
   `docs/DEPLOYMENT_SAFETY.md`). Wajib sebelum migration apa pun.
2. **Jalankan migration** — HANYA setelah disetujui:
   `node backend/scripts/run-dm-control-tower-migration.js` di server
   (idempotent, sudah termasuk `dm_ct_month_config`). Cek 4 tabel baru
   muncul (`dm_ct_raw_register`, `dm_ct_raw_aktivasi`, `dm_ct_raw_trx`,
   `dm_ct_sync_log`) + 1 tabel config (`dm_ct_month_config`).
3. **Deploy backend + frontend** — HANYA setelah disetujui, lewat
   `safe_deploy.py` (jalur deploy resmi, lihat `docs/DEPLOYMENT_SAFETY.md`).
   **Tidak dijalankan sendiri tanpa izin eksplisit user di setiap kesempatan.**
4. **Cek `/health`** — pastikan backend hidup normal setelah deploy
   (`curl -s http://localhost:3001/health` di server, atau lewat
   `safe_deploy.py` yang sudah otomatis cek ini).
5. **Copy Apps Script ke Google Sheet** — buka Google Sheet DM Control
   Tower → Extensions > Apps Script → tempel isi
   `apps-script-dm-control-tower.js` (lihat Bagian 11).
6. **Isi token Apps Script lewat Script Properties** (Project Settings >
   Script Properties > key `SYNC_TOKEN`) dengan token asli server. Jangan
   pernah tulis token asli di chat/dokumentasi/screenshot.
7. **Jalankan sync manual Juni pertama kali** — HANYA setelah disetujui,
   jalankan `pushDmControlTowerSemua()` dari Apps Script Editor, cek log
   (jumlah baris, status HTTP, peringatan `logFieldCoverage`).
8. **Cek analytics** — `GET /api/warroom/dm-control-tower/analytics?bulan=2026-06`
   (pakai token JWT valid) — pastikan angka funnel/segmen masuk akal, cek
   `meta.config_source` sudah `"config"` (bukan `"fallback"`).
9. **Cek halaman `/war-room/dm-control-tower`** — buka dashboard di
   browser, pastikan semua 6 tab menampilkan data dengan benar, tidak ada
   error di console browser.

**Yang TIDAK dijalankan sepihak dalam Prompt 3 ini**: migration production,
deploy production (`safe_deploy.py`), sync production, perubahan Nginx,
dan aktivasi trigger otomatis Apps Script (`setupDmControlTowerTrigger`) —
semuanya menunggu persetujuan eksplisit sesuai instruksi.
