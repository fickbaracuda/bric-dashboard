---
name: bric-production-safety
description: Gerbang manual BACKUP/MIGRATE/DEPLOY, tooling resmi, dan larangan keras seputar production BRIC. Baca sebelum release apa pun.
---

# Production Safety BRIC

Detail lengkap & histori: `docs/DEPLOYMENT_SAFETY.md` dan `BricKnowledge.MD`
§2.1. Ringkasan yang wajib dipatuhi tiap release:

## Tooling resmi (satu-satunya jalur yang boleh dipakai)

| Kebutuhan | Tool | Gerbang konfirmasi |
|---|---|---|
| Deploy frontend + reload backend | `python scripts/safe_deploy.py --execute` (tambah `--confirm-new-commit` kalau server sudah punya commit baru yang sudah diverifikasi) | ketik `DEPLOY` |
| Backup database | `python scripts/backup_db.py` | ketik `BACKUP` |
| Migration production (per fitur) | `python scripts/run_<fitur>_migration_remote.py` (buat baru mengikuti pola `run_payment_agent_produk_migration_remote.py` / `run_dm_control_tower_migration_remote.py` kalau belum ada untuk fitur ini) | ketik `MIGRATE` |
| Cek server tanpa mengubah apa pun | `python scripts/check_server_readonly.py` | — (read-only, aman kapan saja) |

Script `deploy_*.py` lama di root repo, `check_backend.py`, `check_nginx.py`,
`fix_nginx.py`, `restart_backend.py`, `test_sync.py` — **DEPRECATED, jangan
dipakai lagi.** Jangan dihapus (arsip), tapi jangan dijalankan untuk task baru.

## Gerbang manual BACKUP / MIGRATE / DEPLOY — aturan mutlak

Ketiga gerbang ini pakai `input()` interaktif di terminal, **sengaja tidak
bisa dilewati lewat otomatisasi**. Ini kontrol keras, bukan formalitas.

**AI (termasuk sesi ini) TIDAK BOLEH, dalam kondisi apa pun:**
- pipe input ke script ini (`echo DEPLOY | python ...`)
- redirect file berisi kata kunci ke stdin-nya
- pakai `expect` atau tool otomatisasi input sejenis
- mengubah script-nya supaya confirmation dilewati/dilonggarkan
- mencari cara lain untuk "workaround" gerbang ini

(Sebagian ditegakkan otomatis lewat `.claude/hooks/guard.py` — tapi jangan
mengandalkan hook saja, ini aturan yang harus dipahami & dipatuhi sendiri.)

**Kalau task sampai ke titik butuh salah satu gerbang ini: BERHENTI, dan
tampilkan instruksi singkat**, contoh:
```
ACTION REQUIRED:
Ketik DEPLOY pada terminal Anda untuk melanjutkan.
```
Setelah user mengetik & menjalankan sendiri, lanjutkan berdasarkan hasil
yang mereka laporkan (atau baca output-nya kalau tool run di foreground).

## Release Impact — tentukan sebelum minta gerbang apa pun

Sebelum sampai ke BACKUP/MIGRATE/DEPLOY, tentukan dulu task ini butuh apa:
- **Frontend saja** → langsung DEPLOY (safe_deploy.py sudah include build
  frontend), tidak perlu BACKUP/MIGRATE.
- **Backend saja, tanpa perubahan skema DB** → langsung DEPLOY, tidak perlu
  BACKUP/MIGRATE (kecuali kamu sengaja mau jaga-jaga sebelum perubahan
  business-logic besar — diskusikan dengan user kalau ragu).
- **Ada migration/skema DB baru** → BACKUP dulu (wajib), lalu MIGRATE, baru
  DEPLOY.
- **Ada perubahan Apps Script** → jelaskan ke user kode mana yang perlu
  di-copy-paste manual ke Google Apps Script Editor (tidak ada gerbang
  otomatis untuk ini, murni manual).
- **Ada perubahan nginx** (endpoint sync baru dengan payload besar) →
  jelaskan ke user perubahan regex yang dibutuhkan di `bric-bric.conf`
  server; ini butuh akses langsung ke nginx config, bukan bagian dari
  `safe_deploy.py`.

## Larangan keras (production)

- **Jangan** `pkill` untuk mematikan backend.
- **Jangan** jalankan backend manual (`node src/app.js`, `nohup node ...`)
  sebagai `root`. HANYA lewat `sudo -u admin pm2 reload bric-backend`.
- **Jangan** edit source code production langsung lewat SSH (nano/vim/sed -i
  di server). Semua perubahan HARUS lewat git → push → `safe_deploy.py`.
  Pengecualian SATU-SATUNYA: outage darurat P0 di mana dashboard sedang
  down total — kalaupun begitu, hotfix darurat itu WAJIB direkonsiliasi
  balik ke git secepatnya setelah stabil (lihat histori commit `56b8257`
  sebagai preseden), bukan dibiarkan sebagai drift permanen.
- **Jangan** migration destruktif (`DROP TABLE`, `TRUNCATE`, `DELETE`
  tanpa `WHERE`) tanpa backup dulu & tanpa validasi eksplisit dari user.
- **Jangan** deploy kalau build frontend gagal — `safe_deploy.py` sendiri
  sudah stop otomatis di sini, jangan cari cara override.
- **Jangan** taruh credential asli (password VPS, `DATABASE_URL`, token
  sync, `JWT_SECRET`) di file mana pun yang ikut Git.

## Verifikasi setelah deploy

Task development BARU dianggap selesai kalau salah satu dari ini benar:
1. Production versi baru **healthy**: `/health` OK, PM2 restart count naik
   tepat +1 (bukan crash-loop), smoke test endpoint/fitur yang diubah
   menunjukkan hasil benar (bukan cuma "tidak error").
2. Atau, kalau release gagal: **rollback berhasil** dan production kembali
   ke kondisi sehat semula (pakai instruksi rollback yang ditampilkan
   `safe_deploy.py`, atau `git revert` untuk backend + reload PM2).

Jangan laporkan task "selesai" kalau baru sampai tahap push ke `master`
tanpa verifikasi production, KECUALI user eksplisit bilang tidak perlu
deploy sekarang (misal task ini murni persiapan, atau user minta ditunda).
