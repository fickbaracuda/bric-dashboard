# Keamanan Deployment BRIC Dashboard

Dokumen ini ditulis untuk pemilik project yang **bukan orang IT**. Tujuannya:
supaya Anda tetap bisa paham apa yang terjadi di "balik layar" saat proses
update/deploy dashboard, tanpa harus jadi programmer dulu.

---

## STATUS SAAT INI (2026-07-02): Fase Awal SELESAI ✅

**`scripts/safe_deploy.py` sudah berhasil dipakai untuk deploy sungguhan ke
server production untuk pertama kalinya, dan berjalan aman dari awal
sampai akhir** — preflight PASS, build berhasil, backup tampilan lama
dibuat, tampilan baru terpasang, backend di-restart lewat PM2 sebagai
user `admin`, dan kondisi akhir sehat (`/health` OK, tidak perlu rollback).

Mulai sekarang, **`scripts/safe_deploy.py` adalah jalur resmi/utama** untuk
mengirim update dashboard ke production. Script `deploy_*.py` dan
sejenisnya yang lama **tidak boleh dipakai lagi** (lihat poin 5).

Pekerjaan rotasi password/token (mengganti credential lama) **sengaja
belum dikerjakan** — itu keputusan & pekerjaan terpisah untuk nanti,
bukan bagian dari fase ini.

---

## 1. Masalah yang Ditemukan (ringkas)

Saat audit (Part 1), ditemukan beberapa kebiasaan lama yang berisiko:

1. **Password server (VPS) dan "token rahasia" sinkronisasi data tertulis
   langsung di banyak file kode** — siapa pun yang bisa melihat file itu,
   otomatis tahu password/tokennya.
2. **Proses restart aplikasi backend sering "melompati" PM2** (PM2 itu semacam
   "penjaga" yang seharusnya selalu menghidupkan ulang aplikasi dengan aman,
   sebagai user `admin`). Beberapa script lama malah mematikan aplikasi secara
   paksa (`pkill`) lalu menyalakannya manual sebagai `root` — ini berisiko
   dua aplikasi rebutan jalan bersamaan, atau aplikasi mati dan tidak
   otomatis nyala lagi.
3. **Kalau proses "build" tampilan baru gagal, sistem lama tetap saja
   menyalin hasilnya ke server** — bisa jadi yang tersalin adalah tampilan
   LAMA (sisa build sebelumnya), tapi dilaporkan "sukses".
4. **Tidak ada cadangan (backup)** sebelum tampilan lama ditimpa, dan tidak
   ada cadangan database sebelum ada perubahan struktur data (migration).
5. **Tidak ada cara cepat untuk "mundur ke versi sebelumnya"** kalau ada
   yang salah setelah deploy.

Detail lengkap (dengan credential yang sudah disamarkan) ada di laporan
audit Part 1 yang sudah disampaikan sebelumnya.

---

## 2. Apa yang Sudah Dikerjakan di Part 2A

**Semua pekerjaan Part 2A ini adalah PERSIAPAN. Tidak ada satu pun yang
sudah dijalankan ke server production.** Yang dikerjakan:

- Token sinkronisasi data (dipakai Google Apps Script) di 15 file backend
  sekarang **bisa** dibaca dari pengaturan server (environment variable),
  bukan wajib tertulis di kode. **Nilai tokennya TIDAK diganti** — kalau
  pengaturan barunya belum di-set di server, sistem tetap jalan seperti
  biasa (pakai nilai lama sebagai cadangan). Jadi ini AMAN, tidak akan
  membuat Apps Script tiba-tiba berhenti sinkron.
- File contoh pengaturan (`.env.example`) dirapikan — sebelumnya file ini
  ternyata memuat token ASLI sebagai "contoh" (sudah diganti jadi
  contoh palsu).
- Disiapkan alat bantu baru (dijelaskan satu-satu di bawah) untuk:
  cek kesiapan sebelum deploy, backup database, backup tampilan lama,
  dan proses deploy yang lebih aman.
- 12 file script lama sudah diberi **label peringatan** di bagian atas
  file (bertuliskan `[DEPRECATED]` / jangan dipakai lagi), tapi **isi
  aslinya (termasuk password lama) belum dihapus** — supaya tidak ada
  yang tiba-tiba rusak sebelum penggantinya benar-benar siap dipakai.

---

## 3. Alat Bantu Baru — Fungsinya Masing-masing

### `backend/scripts/preflight-check.js` — "Cek dulu sebelum jalan"
Ibarat cek pra-terbang pesawat: sebelum deploy, script ini mengecek apakah
semua pengaturan penting sudah lengkap, dan apakah script deploy baru
sudah mengikuti aturan aman (tidak pakai `pkill`, restart lewat PM2 yang
benar, dll). Script ini **hanya membaca & melapor**, tidak mengubah apa pun.

**Cara pakai** (nanti, saat sudah siap):
```
node backend/scripts/preflight-check.js
node backend/scripts/preflight-check.js --production
```
Semua password/token di laporannya otomatis disamarkan, tidak pernah
ditampilkan lengkap.

### `scripts/backup_db.py` — "Cadangan database"
Membuat salinan seluruh isi database (pakai alat resmi PostgreSQL bernama
`pg_dump`), disimpan di server DAN disalin juga ke komputer ini, dengan
nama file mengandung tanggal & jam. Tidak mengubah/menghapus data apa pun.

**Cara pakai** (nanti, kalau diperintahkan):
```
python scripts/backup_db.py
```
Script akan minta konfirmasi ketik `BACKUP` dulu sebelum benar-benar jalan.

### `scripts/safe_deploy.py` — "Deploy dengan pengaman" (JALUR DEPLOY UTAMA ✅)
**Ini sekarang jalur resmi untuk deploy dashboard ke production**, sudah
terbukti berhasil dipakai sungguhan (2026-07-02). Menggantikan semua
script `deploy_*.py` yang lama. Urutan kerjanya jauh lebih aman:
cek Git → tarik kode terbaru → cek kesiapan (preflight) → build tampilan
baru → **kalau build gagal, berhenti, tidak ada yang disalin** → cadangan
tampilan lama → pasang tampilan baru → restart backend LEWAT PM2 (bukan
`pkill`) → cek kesehatan sistem → kalau ada yang gagal, tampilkan cara
mundur ke versi sebelumnya.

**Mode aman by default**: kalau dijalankan tanpa embel-embel apa pun, script
ini **HANYA menampilkan rencana**, tidak menyambung ke server sama sekali.
```
python scripts/safe_deploy.py
```
Baru kalau sudah disetujui dan siap dipakai sungguhan:
```
python scripts/safe_deploy.py --execute
```
(masih akan tanya konfirmasi ketik `DEPLOY` sekali lagi sebelum benar-benar jalan)

### `backend/src/config/env.js` — helper untuk kunci keamanan login
Disiapkan sebagai langkah awal supaya nanti "kunci cadangan" (JWT secret)
yang saat ini tertulis di kode bisa dihilangkan dengan aman. **Belum
dipakai/disambungkan ke sistem login yang sekarang** — supaya tidak ada
risiko semua orang mendadak logout atau sistem gagal jalan. Ini akan
disambungkan di Part 2B, setelah kita pastikan dulu server production
sudah punya kunci JWT-nya sendiri.

### `.env.deploy.example` dan `backend/.env.example`
File contoh pengaturan (bukan pengaturan asli). Dipakai sebagai panduan
kalau nanti perlu membuat file pengaturan sungguhan (`.env` / `.env.deploy`)
yang isinya credential asli — file asli itu TIDAK akan pernah ikut ke Git.

---

## 4. Cara Menjalankan (untuk nanti, bukan sekarang)

> Semua contoh di bawah ini BOLEH dibaca-baca dulu, tapi mohon **jangan
> dijalankan ke server production sebelum kita bahas bersama** di Part 2B/2C.

**Cek kesiapan (preflight):**
```
node backend/scripts/preflight-check.js --production
```

**Backup database:**
```
python scripts/backup_db.py
```
lalu ketik `BACKUP` saat diminta konfirmasi.

**Backup tampilan (frontend) production:**
Sudah otomatis jadi bagian dari `scripts/safe_deploy.py` (langkah ke-4 dari 8),
jadi tidak perlu dijalankan terpisah.

**Cek server tanpa mengubah apa pun (read-only):**
```
python scripts/check_server_readonly.py
```
Mengecek: repo ada, frontend ada, status PM2, kesehatan backend, Node/npm
tersedia, dan environment variable mana saja yang sudah/belum di-set di
server — tanpa pernah menampilkan nilai aslinya, dan tanpa mengubah apa pun.

**Rollback (mundur ke versi tampilan sebelumnya) kalau ada masalah:**
Setiap kali `safe_deploy.py` jalan, dia membuat folder cadangan dengan nama
mengandung tanggal & jam, contoh: `/var/www/bric_backup_20260702_193000`.
Untuk mundur:
```
sudo rm -rf /var/www/bric/*
sudo cp -r /var/www/bric_backup_20260702_193000/* /var/www/bric/
```
(Ganti tanggal/jam sesuai nama folder backup yang mau dipakai.)

---

## 5. Hal yang TIDAK BOLEH Dilakukan

- **Jangan** menjalankan `pkill` untuk mematikan backend.
- **Jangan** menjalankan backend secara manual (`node src/app.js` atau
  `nohup node ...`) sebagai `root`. Backend HANYA boleh dikelola lewat
  `sudo -u admin pm2 reload bric-backend`.
- **Jangan** menaruh password/token asli di file yang ikut Git (file
  `.env`, `.env.deploy`, atau file kredensial apa pun).
- **Jangan** menjalankan migration database di production tanpa backup
  dulu (`scripts/backup_db.py`).
- **Jangan** menghapus file script lama (`deploy_*.py`, `check_*.py`, `fix_nginx.py`,
  `restart_backend.py`, `test_sync.py`) — sudah ditandai `[DEPRECATED]` /
  jangan dipakai lagi, tapi disimpan sebagai arsip, bukan dihapus.
- **Jangan** menjalankan `scripts/safe_deploy.py --execute` tanpa alasan
  jelas — walau sudah terbukti aman, ini tetap aksi nyata ke production.
  Diskusikan dulu kalau ragu.
- **Jangan** mulai rotasi credential (password VPS, token, JWT) tanpa
  pembahasan terpisah — itu pekerjaan lain, bukan bagian dari deploy rutin.

---

## 6. Kapan Harus Berhenti dan Minta Pengecekan

Berhenti dan tanya dulu (jangan lanjut sendiri) kalau:
- Preflight check melaporkan "GAGAL".
- Build frontend gagal berulang kali.
- Health check (`http://localhost:3001/health`) tidak merespons "sehat"
  setelah deploy.
- Ada pesan error yang tidak Anda pahami sama sekali.
- Ada permintaan (dari siapa pun, termasuk AI) untuk menjalankan sesuatu
  yang menyebutkan kata "drop table", "truncate", "delete", "pkill", atau
  "force" — ini semua tanda bahaya, tunda dan konfirmasi dulu.

---

## 7. Anda Tetap Bisa Bekerja Seperti Biasa

Semua di atas dirancang supaya Anda tetap bisa memberi instruksi dengan
kalimat biasa (bukan kode), misalnya:

> "Tolong cek dulu apakah aman untuk deploy sekarang"
> "Tolong buat cadangan database sebelum kita lanjut"
> "Kalau semua aman, tolong jalankan deploy-nya"

AI akan menjalankan alat-alat di atas sesuai permintaan, tetap melaporkan
hasilnya dalam bahasa yang mudah dipahami, dan tetap berhenti dulu kalau
ada tanda risiko seperti di poin 6.

---

## 8. Status Part 2B (validasi & dry-run)

Part 2B menambahkan:
- `scripts/check_server_readonly.py` — alat cek kondisi server tanpa mengubah
  apa pun (dijelaskan di poin 4 di atas).
- `backend/scripts/preflight-check.js` sekarang punya 3 status: **PASS**
  (aman lanjut), **WARNING** (ada yang sebaiknya dibereskan tapi tidak
  menghalangi), **FAIL** (wajib dibereskan dulu, jangan lanjut deploy).
- `scripts/safe_deploy.py` dirapikan jadi 8 langkah yang jelas, dan bisa
  dijalankan dengan `--dry-run` (sama seperti tanpa embel-embel apa pun)
  untuk sekadar melihat rencananya tanpa menyambung ke server.

**Catatan jujur:** validasi LANGSUNG ke server production (poin C di
permintaan Part 2B) **belum bisa dijalankan** di sesi ini, karena belum
ada cara aman untuk memberi tahu AI password/akses VPS. AI **sengaja
tidak mengambil password dari file lama** (`check_backend.py` dkk) karena
itu akan bertentangan dengan semua yang sudah dibangun di Part 2A. Lihat
poin 10 untuk pilihan cara melanjutkan ini.

---

## 9. Checklist Rotasi Credential (BELUM dijalankan — untuk referensi)

Ini daftar credential yang sebaiknya diganti (dirotasi) di masa depan,
beserta dampaknya kalau diganti. **Belum satu pun yang diganti** — ini
hanya catatan rencana.

| Credential | Dampak kalau diganti |
|---|---|
| Password SSH VPS | Semua script/alat yang menyambung ke server (termasuk yang baru) harus pakai password baru. Tidak berdampak ke user dashboard biasa. **Update 2026-07-03**: komputer yang sudah pakai SSH key (lihat Bagian 13) TIDAK terpengaruh rotasi password ini sama sekali — akses key terpisah dari password, dan sebaiknya justru dijadikan cara akses UTAMA (password login root bisa dinonaktifkan sepenuhnya nanti demi keamanan lebih baik, itu pembahasan terpisah). |
| `JWT_SECRET` | **Semua orang yang sedang login akan otomatis logout** dan harus login ulang. Tidak ada data yang hilang, hanya sesi login yang direset. Sebaiknya dilakukan di luar jam sibuk. |
| `APPS_SCRIPT_TOKEN` (token sync umum) | Google Apps Script yang mengirim data (Speedcash, Ekspedisi, Fastpay, dll) **harus diperbarui juga** dengan token baru, kalau tidak, sinkronisasi data akan berhenti (gagal, bukan merusak data). |
| `MGM_PA_SYNC_TOKEN` | Sama seperti di atas, tapi khusus untuk Apps Script MGM PA saja. |
| Token Apps Script lain yang terkait | Perlu dicek satu-satu, karena beberapa fitur (mis. QRIS Control Tower) punya Apps Script sendiri yang juga menyimpan token ini. |
| Password/credential database | **Paling berisiko** — kalau salah ganti atau lupa update di server, backend bisa gagal konek ke database sepenuhnya (dashboard mati total). Harus dilakukan sangat hati-hati, idealnya dengan backup database dulu dan di luar jam kerja. |

**Urutan rotasi yang disarankan (nanti, bukan sekarang):** mulai dari yang
paling rendah risiko dulu → password SSH VPS → token sync (satu-satu,
sambil update Apps Script terkait) → JWT_SECRET (di luar jam sibuk) →
credential database (paling terakhir, dengan backup dulu).

---

## 10. Pilihan untuk Melanjutkan Validasi Server Sungguhan

Karena AI tidak punya cara aman untuk tahu password VPS di sesi ini, ada
3 pilihan untuk lanjut ke Part 2C:

1. **Anda buat file `.env.deploy` sendiri** (dari contoh `.env.deploy.example`,
   isi dengan alamat & password VPS asli), simpan di folder utama project.
   Anda **tidak perlu memberi tahu isinya ke siapa pun** — begitu file itu
   ada, AI bisa menjalankan `scripts/check_server_readonly.py` dan
   script lain akan otomatis memakainya tanpa pernah menampilkan isinya.
2. **Anda jalankan sendiri** `python scripts/check_server_readonly.py` di
   komputer Anda (akan tanya password saat diketik, tidak terlihat di
   layar), lalu salin-tempel HASIL LAPORANNYA (bukan passwordnya) ke chat
   supaya AI bisa membacakan artinya.
3. **Lewati dulu validasi server sungguhan**, lanjut ke persiapan lain
   dulu, dan baru validasi server saat benar-benar mau deploy pertama kali.

---

## 11. Anda Tetap Bisa Bekerja Seperti Biasa

Semua di atas dirancang supaya Anda tetap bisa memberi instruksi dengan
kalimat biasa (bukan kode), misalnya:

> "Tolong cek dulu apakah aman untuk deploy sekarang"
> "Tolong buat cadangan database sebelum kita lanjut"
> "Kalau semua aman, tolong jalankan deploy-nya"

AI akan menjalankan alat-alat di atas sesuai permintaan, tetap melaporkan
hasilnya dalam bahasa yang mudah dipahami, dan tetap berhenti dulu kalau
ada tanda risiko seperti di poin 6.

---

## 12. Ringkasan Pencapaian Fase Ini (selesai)

- ✅ Validasi server production (read-only) berhasil dijalankan.
- ✅ Environment variable yang tadinya hilang (`NODE_ENV`, `ALLOWED_ORIGIN`,
  `MGM_PA_SYNC_TOKEN`) sudah dilengkapi di server, dengan backup `.env` dulu.
- ✅ `preflight-check.js` sudah diuji sungguhan di server dan berstatus PASS.
- ✅ `scripts/safe_deploy.py` sudah diuji dry-run berkali-kali, lalu **berhasil
  dipakai sungguhan (`--execute`)** untuk deploy pertama ke production
  (2026-07-02) — build, backup, copy, reload PM2, health check, semuanya sehat.
- ✅ 12 script lama sudah ditandai `[DEPRECATED]`, belum dihapus.

**Pekerjaan yang SENGAJA belum dikerjakan (bukan bagian dari fase ini,
akan dibahas terpisah nanti kalau/ketika dibutuhkan):**
- Rotasi credential (password VPS, token sync, JWT) — checklist & dampaknya
  sudah dicatat di poin 9, tapi **belum satu pun dijalankan**.
- Menyambungkan `backend/src/config/env.js` ke sistem login sungguhan.
- Menghapus nilai token lama yang masih jadi "cadangan" di kode backend.
- Merapikan kode fitur dashboard yang sudah live di server tapi belum
  ter-commit ke Git (dikonfirmasi pemilik project sebagai kondisi yang
  disengaja per 2026-07-02 — lihat komentar di `scripts/safe_deploy.py`).
- Menghapus/merapikan file backup lama (`.env.backup.*`, `*_backup_*`)
  yang sudah menumpuk di server.

---

## 13. Akses SSH Tanpa Password (2026-07-03)

Sejak tanggal ini, komputer yang sudah di-setup (lihat langkah di bawah)
bisa menyambung ke server BRIC **tanpa mengetik password VPS setiap kali**
— memakai SSH key, bukan password. Ini menggantikan kebutuhan mengetik
password interaktif untuk `safe_deploy.py`, `backup_db.py`,
`check_server_readonly.py`, dan script sejenis lainnya — **script-nya
sendiri TIDAK berubah cara pakainya**, cuma tidak lagi tanya password
kalau key sudah terpasang.

**PENTING — ini mengubah "rem tangan" yang sebelumnya berlaku**: sebelum
ini, aturan tak tertulis kita adalah "harus ada manusia yang mengetik
password setiap kali sebelum apa pun menyentuh server" — itu jadi
pengaman terakhir. Dengan SSH key, akses ke server (sebagai `root`, penuh)
jadi otomatis begitu ada yang menjalankan script dari komputer yang
key-nya terpasang. Ini pilihan yang disetujui sadar oleh pemilik project
(bukan default/otomatis) — kalau suatu saat mau kembali ke wajib password
manual, tinggal hapus/nonaktifkan key (lihat "Cara Mencabut Akses" di bawah).

### Cara kerja singkat
1. Ada SSH key (sepasang: privat + publik) khusus BRIC di komputer:
   `~/.ssh/bric_prod_ed25519` (privat, JANGAN PERNAH dibagikan/di-commit)
   dan `~/.ssh/bric_prod_ed25519.pub` (publik, aman dibagikan).
2. Public key-nya sudah didaftarkan ke server, di file
   `/root/.ssh/authorized_keys` (server-side, bukan bagian dari repo Git).
3. Ada alias `bric-prod` di `~/.ssh/config` (komputer lokal, di luar folder
   project, TIDAK ikut Git) yang menghubungkan alias itu ke IP server,
   user `root`, dan key di atas.
4. `scripts/deploy_common.py` (dipakai semua script keamanan) sekarang
   otomatis mendeteksi alias `bric-prod` ini duluan — kalau ketemu dan
   key-nya ada, langsung pakai itu (tanpa tanya password). Kalau TIDAK
   ketemu (mis. di komputer lain yang belum di-setup), otomatis kembali ke
   cara lama (tanya password interaktif) — jadi tetap kompatibel.

### Setup di komputer baru (kalau perlu, sekali saja per komputer)
1. Buat key baru: `ssh-keygen -t ed25519 -f ~/.ssh/bric_prod_ed25519 -N ""`
2. Daftarkan public key ke server (masih perlu password VPS **1x terakhir**
   di langkah ini saja):
   ```powershell
   $pubKey = (Get-Content "$env:USERPROFILE\.ssh\bric_prod_ed25519.pub").Trim()
   ssh root@147.139.201.43 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qxF '$pubKey' ~/.ssh/authorized_keys 2>/dev/null || echo '$pubKey' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY_ADDED_OK"
   ```
3. Buat/tambahkan ke `~/.ssh/config`:
   ```
   Host bric-prod
     HostName 147.139.201.43
     User root
     IdentityFile ~/.ssh/bric_prod_ed25519
     IdentitiesOnly yes
   ```
4. Tes: `ssh bric-prod "hostname && whoami"` — harus langsung masuk tanpa
   tanya password.

### Cara deploy sekarang (tidak berubah, cuma tanpa prompt password)
```
python scripts/safe_deploy.py --execute
```
Tetap akan minta ketik `DEPLOY` untuk konfirmasi (pengaman ini TIDAK
dihilangkan), tapi tidak lagi tanya alamat server/user/password — semua
otomatis dari alias `bric-prod`.

### Hal yang TETAP TIDAK BOLEH dilakukan
Semua aturan di Bagian 5 tetap berlaku persis sama — SSH key hanya
mengganti CARA menyambung ke server, bukan mengubah apa yang boleh
dijalankan di server. Tetap: tidak ada `pkill`, restart backend tetap
wajib lewat `sudo -u admin pm2 reload bric-backend`, migration tetap wajib
backup dulu, `safe_deploy.py --execute` tetap butuh alasan jelas.

### Cara Mencabut Akses (kalau suatu saat perlu)
Kalau laptop hilang/dicuri, atau ingin kembali wajib password manual:
1. SSH ke server (masih bisa pakai password root biasa kalau key belum
   dicabut, atau lewat akses konsol VPS provider kalau perlu):
   ```
   nano /root/.ssh/authorized_keys
   ```
2. Hapus baris yang mengandung komentar `bric-prod-vscode-...` (nama key
   ada di ujung baris publicnya), simpan.
3. Di komputer yang mau dicabut aksesnya, hapus juga:
   `~/.ssh/bric_prod_ed25519`, `~/.ssh/bric_prod_ed25519.pub`, dan entri
   `Host bric-prod` di `~/.ssh/config` (opsional, tidak wajib, tapi rapi).
4. Setelah baris itu dihapus dari server, semua script otomatis kembali
   ke alur lama (tanya password interaktif) di komputer manapun.

### Verifikasi tidak ada credential bocor
- Private key (`bric_prod_ed25519`) ada di `~/.ssh/`, folder ini **di luar**
  folder project `bric-dashboard/` sama sekali — tidak mungkin ikut Git
  kecuali sengaja dicopy ke dalam folder project.
- `.gitignore` sudah ditambah pola `id_ed25519*`, `*_ed25519*`, dan `.ssh/`
  sebagai jaring pengaman tambahan kalau suatu saat ada yang taruh key di
  dalam folder project.
- `~/.ssh/config` juga di luar folder project, tidak ikut Git.
- `git status` dicek setelah setup ini — tidak ada file baru terkait SSH
  key yang muncul di daftar perubahan repo.
