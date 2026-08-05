---
name: bric-git-workflow
description: Konvensi branch, identitas developer, dan alur git untuk task development BRIC (dipakai skill bric-release).
---

# Git Workflow & Identitas Developer BRIC

## Identitas developer (multi-komputer, multi-akun)

BRIC dikerjakan dari lebih dari satu komputer/akun Claude (owner & Febri).
Identitas developer disimpan **lokal per komputer**, di `CLAUDE.local.md`
(root project, **TIDAK ikut Git** — lihat `.gitignore`).

Format `CLAUDE.local.md`:
```markdown
developer_id: owner
```
atau
```markdown
developer_id: febri
```

**Sebelum development task apa pun yang butuh branch/commit/push**, cek
apakah `CLAUDE.local.md` ada dan berisi `developer_id`. Kalau tidak ada
atau tidak terbaca: **jangan menebak** — tanya user sekali ("komputer ini
developer_id apa, owner atau febri?"), lalu tulis jawabannya ke
`CLAUDE.local.md` supaya tidak perlu ditanya lagi di sesi berikutnya.

Template referensi (ikut Git, bukan file sungguhan) ada di
`CLAUDE.local.md.example`.

## Authorized Release Maintainer

`owner` dan `febri` **keduanya** adalah Authorized Release Maintainer.
Keduanya boleh, tanpa perlu approval dari pihak lain:
- development & self-review
- merge ke `master`
- release ke production (lewat gerbang manual BACKUP/MIGRATE/DEPLOY, lihat
  `.claude/rules/production-safety.md`)

Tidak ada reviewer kedua yang wajib untuk release siapa pun.

## Branch convention

- **Jangan pernah coding langsung di `master`.**
- Nama branch: `<developer_id>/<task-slug>`, contoh:
  `owner/fix-farming-juli`, `febri/menu-pa-produk-baru`.
- `task-slug` singkat, kebab-case, dari isi task (bukan tanggal/waktu).

## Alur standar per task development

1. `git fetch origin` — lihat kondisi terbaru `master` sebelum mulai.
2. `git checkout -b <developer_id>/<task-slug>` dari `master` terbaru.
3. Kerjakan task di branch ini.
4. Sebelum commit: self-review diff (lihat checklist di skill
   `bric-release`), jalankan test yang relevan.
5. `git add <file-file task saja>` — jangan `git add -A`/`git add .` kalau
   ada kemungkinan file lain (script pribadi, backup, dsb) ikut ter-stage.
6. Commit dengan pesan jelas (why, bukan cuma what), co-authored footer
   standar Claude Code.
7. `git push -u origin <branch>`.
8. **Sync ulang sebelum merge**: `git fetch origin master`, lalu
   `git merge origin/master` (bukan rebase, supaya history developer lain
   tidak ditulis ulang) ke branch task. Kalau ada conflict, selesaikan
   TANPA menghapus/mengganti perubahan developer lain yang tidak
   berhubungan dengan task ini — kalau ragu perubahan siapa yang benar,
   berhenti dan tanya.
9. Jalankan ulang test setelah sync.
10. Merge ke `master` HANYA kalau semua validasi PASS:
    `git checkout master && git merge --no-ff <branch>`, lalu `git push origin master`.
11. Lanjut ke Release Impact / deploy (lihat skill `bric-release`).

## Yang TIDAK boleh (ditegakkan sebagian lewat hook, lihat
`.claude/hooks/guard.py`)

- `git push --force` / `-f` — hard block via hook. Kalau memang perlu,
  minta Authorized Release Maintainer menjalankan sendiri di terminalnya.
- `git reset --hard` — hard block via hook. Kalau memang perlu (misal
  membuang eksperimen sendiri di branch sendiri), user yang jalankan manual.
- `git clean -f`/`-fd` — hard block via hook (bisa menghapus untracked
  files developer lain).
- `--no-verify` / `--no-gpg-sign` — hard block via hook.
- Commit file `.env` asli — hard block via hook (hanya `.env.example` dan
  `.env.deploy.example` yang boleh).

## Kapan TIDAK perlu branch/commit sama sekali

Kalau user hanya bertanya, minta analisis/investigasi, atau minta
penjelasan (read-only) — jangan buat branch, jangan commit apa pun. Cukup
jawab langsung. Lihat `.claude/skills/bric-release/SKILL.md` bagian
"Kapan skill ini TIDAK dipakai".
