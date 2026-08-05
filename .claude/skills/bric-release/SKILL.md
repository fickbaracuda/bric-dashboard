---
name: bric-release
description: Alur resmi development + release BRIC Dashboard — dari branch, implementasi, self-review, test, sampai deploy production dengan gerbang manual BACKUP/MIGRATE/DEPLOY. Gunakan otomatis untuk permintaan development apa pun terhadap source code BRIC (fitur baru, perbaikan bug, revisi, refactor, improvement) "sampai live"/"sampai production", atau eksplisit lewat perintah /bric-release. JANGAN gunakan untuk pertanyaan, analisis, atau investigasi read-only.
---

# BRIC Release — Autonomous Development Workflow

Ini adalah workflow resmi untuk SEMUA task development di BRIC Dashboard.
Tujuannya: user cukup bilang "tambahkan fitur X sampai live" atau
"perbaiki bug Y sampai production normal", dan seluruh alur di bawah ini
berjalan tanpa perlu diinstruksikan langkah demi langkah.

Bisa dipanggil eksplisit lewat `/bric-release <task>`, tapi pemanggilan
eksplisit itu OPSIONAL — permintaan natural-language yang jelas maksudnya
development harus otomatis memicu workflow ini juga.

## Kapan skill ini DIPAKAI

Permintaan yang mengandung maksud mengubah source code, contoh kata kunci:
buat fitur, tambah fitur, revisi fitur, perbaiki bug, ubah dashboard,
improvement, implementasikan, refactor, fix, "sampai live", "sampai
production", "kerjakan [nama fitur/dashboard]".

## Kapan skill ini TIDAK DIPAKAI

Kalau user **hanya** bertanya, minta analisis, minta penjelasan, atau minta
investigasi read-only ("kenapa X lambat?", "jelaskan alur Y", "menurutmu
apa penyebabnya?") — **JANGAN** otomatis buat branch/commit/deploy. Jawab
pertanyaannya dulu. Kalau dari jawaban itu ternyata memang perlu perubahan
kode, konfirmasi singkat dulu ("mau saya perbaiki sekaligus?") kecuali
konteksnya sudah sangat jelas user memang mau itu dikerjakan sampai selesai.

## Aturan pendukung (baca sesuai kebutuhan, jangan disalin ke sini)

- `.claude/rules/architecture.md` — kolom war-room, single-snapshot vs
  multi-bulan, domain terpisah, RBAC, sync token, business logic per domain.
- `.claude/rules/git-workflow.md` — identitas developer (`CLAUDE.local.md`),
  branch convention, alur sync/merge.
- `.claude/rules/production-safety.md` — tooling resmi, gerbang manual
  BACKUP/MIGRATE/DEPLOY, larangan keras, kriteria "selesai".
- `.claude/rules/security.md` — credential, secret, RBAC.
- `CLAUDE.md` — peta lengkap route/tabel/menu (baseline).
- `BricKnowledge.MD` — fitur yang dibangun setelah `CLAUDE.md` terakhir
  diperbarui; baca ini juga untuk fitur-fitur baru (Rekonsiliasi bank,
  Balance Control Tower, Balance & Funding, DM Control Tower, Farming
  Command Center, Payment Agent Produk baru, dll).
- `docs/<FITUR>.md` — dokumentasi spesifik per fitur kalau ada, baca
  sebelum mengubah domain tersebut.

---

## FASE 1 — UNDERSTAND

1. Baca dokumentasi relevan dengan task ini: `CLAUDE.md`, `BricKnowledge.MD`
   bagian terkait, `docs/<FITUR>.md` kalau ada untuk domain yang disentuh.
2. Cek existing architecture: buka file route/komponen yang relevan,
   JANGAN asumsi pola dari domain lain otomatis berlaku (lihat
   `.claude/rules/architecture.md`).
3. `git status` — cek ada uncommitted work yang bukan milikmu sebelum
   menyentuh apa pun.
4. `git fetch origin` — lihat kondisi `master` terbaru.

## FASE 2 — GIT (mulai branch)

1. Pastikan `CLAUDE.local.md` ada & berisi `developer_id`. Kalau tidak,
   tanya user sekali (lihat `.claude/rules/git-workflow.md`), simpan
   jawabannya lokal.
2. `git checkout -b <developer_id>/<task-slug>` dari `master` terbaru.
   **Jangan coding di `master`.**

## FASE 3 — IMPLEMENT

1. Kerjakan task, pertahankan arsitektur BRIC yang sudah ada (pola
   route/tabel/CSS-prefix/RBAC existing untuk domain yang disentuh).
2. Ikuti gaya kode & konvensi file tetangga di domain yang sama.
3. Kalau ada ambiguitas signifikan yang cuma user yang bisa jawab
   (bukan sekadar pilihan implementasi teknis) — tanya sebelum lanjut jauh.

## FASE 4 — SELF REVIEW

Review SELURUH diff (`git diff`) sebelum commit, cek:
- **Regression** — apakah ada behavior lama yang tidak sengaja berubah?
- **Unrelated files** — apakah ada file yang ter-modify tapi tidak
  berhubungan dengan task ini? Jangan stage file itu.
- **Secrets** — apakah ada credential/token yang ter-tulis di diff?
- **API contract** — apakah endpoint/response shape yang sudah dipakai
  frontend lain tetap kompatibel, atau memang sengaja diubah (dan
  frontend-nya ikut disesuaikan)?
- **RBAC** — apakah perubahan ini mempertahankan pembagian akses
  admin/viewer atau OP/FA yang relevan?
- **Database** — apakah butuh migration baru? Apakah nama kolom
  konsisten dengan konvensi domain itu (jangan asumsi dari domain lain)?
- **Apps Script** — kalau ada perubahan sync payload, apakah
  `apps-script-*.js` terkait juga perlu diupdate? Apakah `cleanNum()`
  guard `typeof v === 'number'` ada kalau menambah parsing angka baru?
- **Nginx** — kalau ada endpoint sync baru dengan payload besar, apakah
  perlu ditambahkan ke regex whitelist nginx (jelaskan ke user, ini butuh
  akses config server manual)?
- **Data parsing** — kalau ada asumsi format tanggal/angka baru, apakah
  sudah dicek melawan data asli, bukan asumsi format ideal?

## FASE 5 — TEST

- Frontend: `npm run build` (di `frontend/`) kalau ada perubahan frontend —
  build harus sukses, tidak boleh ada warning yang menandakan bug (contoh
  nyata: komentar CSS mengandung `*/` yang menutup comment prematur).
- Backend: jalankan test yang tersedia untuk domain terkait, contoh pola
  `backend/scripts/test-*.js` (pakai `assert` polos, lihat
  `test-qris-control-tower.js`, `test-balance-funding-engine.js` sebagai
  referensi pola). Kalau domain ini belum punya test dan perubahannya
  berisiko (business logic kompleks), pertimbangkan buat test baru
  mengikuti pola yang sama.
- Migration: kalau ada file `.sql` baru, review isinya sekali lagi untuk
  memastikan tidak destruktif tanpa alasan, dan idempotent kalau memang
  perlu dijalankan ulang aman.

## FASE 6 — FIX

Kalau ada test yang gagal atau build gagal: perbaiki sebelum lanjut.
**Jangan lanjut ke release dengan kondisi known-broken.**

## FASE 7 — COMMIT

1. `git add` **hanya file task ini** (bukan `-A`/`.` serampangan).
2. Commit dengan pesan jelas: fokus ke "why", bukan cuma "what". Sertakan
   footer co-author standar Claude Code.
3. `git push -u origin <developer_id>/<task-slug>`.

## FASE 8 — SYNC

1. `git fetch origin master`.
2. `git merge origin/master` ke branch task (bukan rebase — jangan tulis
   ulang history developer lain).
3. Resolve conflict TANPA menghapus pekerjaan developer lain yang tidak
   terkait task ini. Kalau ragu perubahan mana yang benar, berhenti & tanya.
4. Jalankan ulang test (Fase 5) setelah sync.

## FASE 9 — MERGE

Merge ke `master` HANYA kalau seluruh validasi (Fase 5 & 8) PASS:
```
git checkout master
git merge --no-ff <developer_id>/<task-slug>
git push origin master
```

## FASE 10 — RELEASE IMPACT

Tentukan kebutuhan release berdasarkan diff yang baru di-merge:
- Frontend saja / Backend saja / Database (migration) / env var baru /
  Apps Script / Nginx config.
Lihat `.claude/rules/production-safety.md` bagian "Release Impact" untuk
menentukan gerbang mana yang perlu dilewati.

## FASE 11 — BACKUP (kalau dibutuhkan)

Kalau Fase 10 menyimpulkan ada perubahan skema database: tampilkan
instruksi, minta user jalankan `python scripts/backup_db.py` dan ketik
`BACKUP`. **Jangan lanjut ke MIGRATE sebelum user konfirmasi backup selesai.**

## FASE 12 — MIGRATION (kalau dibutuhkan)

Kalau ada migration baru: pastikan ada file `.sql` di
`backend/src/migrations/` + runner `backend/scripts/run-<fitur>-migration.js`
(pola: baca `.sql`, `pool.query(sql)`, verifikasi tabel, `pool.end()`).
Untuk production, buat/pakai `scripts/run_<fitur>_migration_remote.py`
mengikuti pola `run_payment_agent_produk_migration_remote.py`. Minta user
jalankan dan ketik `MIGRATE`.

## FASE 13 — DEPLOY

Minta user jalankan `python scripts/safe_deploy.py --execute` (tambah
`--confirm-new-commit` kalau diminta script-nya) dan ketik `DEPLOY`.
**AI tidak pernah menjalankan atau memberi input ke gerbang ini sendiri**
— lihat `.claude/rules/production-safety.md`.

## FASE 14 — VERIFY PRODUCTION

Setelah user melaporkan deploy selesai:
1. Cek `/health`.
2. Cek PM2 (`sudo -u admin pm2 list`) — restart count naik wajar (+1),
   bukan crash-loop.
3. Cek log kalau ada indikasi masalah (`/home/admin/.pm2/logs/bric-backend-*.log`).
4. Smoke test endpoint/fitur yang diubah — pastikan data yang dikembalikan
   BENAR (bukan cuma "tidak error"). Untuk perubahan data-sensitive, verifikasi
   dengan query/script kecil terhadap data production, bukan asumsi.
5. Kalau ada perubahan frontend, konfirmasi (lewat deskripsi ke user, atau
   screenshot yang mereka kirim) bahwa halaman yang diubah tampil benar.

## FASE 15 — ROLLBACK (kalau perlu)

Kalau verifikasi gagal: ikuti instruksi rollback yang ditampilkan
`safe_deploy.py` (restore folder backup frontend) dan/atau `git revert` +
reload PM2 untuk backend. Setelah rollback, verifikasi ulang production
kembali sehat.

## FASE 16 — DONE

Task dianggap selesai HANYA kalau:
- Production versi baru **healthy**, ATAU
- Rollback berhasil dan production kembali ke kondisi sehat semula.

Laporkan hasil akhir singkat: apa yang berubah, di mana (branch/commit),
status production sekarang.
