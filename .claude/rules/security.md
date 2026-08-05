---
name: bric-security
description: Aturan credential, secret, dan RBAC untuk BRIC — jangan hardcode, jangan commit, jangan expose.
---

# Security BRIC

## Credential & secret

- **Jangan pernah** menulis password VPS, `DATABASE_URL`, token sync
  (`bric2026bimasaktisecret`, `bric2026mgmpasecret`, dll), atau
  `JWT_SECRET` sebagai plaintext ke file mana pun yang ikut Git — termasuk
  file dokumentasi. Sudah ada insiden nyata password ter-expose di
  beberapa `deploy_*.py` lama (deprecated, arsip) — jangan direplikasi ke
  file baru.
- Kalau butuh akses VPS untuk task (bukan release resmi lewat
  `safe_deploy.py`/`backup_db.py`), pakai `scripts/deploy_common.py` /
  alias SSH key `bric-prod` di `~/.ssh/config` kalau tersedia di komputer
  itu (lihat `docs/DEPLOYMENT_SAFETY.md` §13) — jangan taruh password di
  command line mentah (kena hook Bash yang menganggap ini command
  mencurigakan, dan berisiko ke-log di history shell).
- Environment variable (backend `.env`) adalah sumber kebenaran untuk
  credential di server — jangan hardcode token/secret baru di kode kalau
  bisa dibaca dari env, ikuti pola `backend/src/config/env.js` yang sudah
  disiapkan untuk migrasi bertahap.
- Sebelum commit: kalau ada file yang isinya mencurigakan (nama file
  terlihat biasa tapi kamu ragu), buka isinya dulu sebelum `git add`.

## RBAC

- Autentikasi dashboard pakai 2 mekanisme yang TIDAK BOLEH tertukar:
  JWT (`requireAuth`, untuk semua endpoint GET/CRUD analytics) vs token
  sync non-JWT (untuk endpoint `POST .../sync` dari Google Apps Script).
  Jangan pasang `requireAuth` di endpoint sync, dan jangan hilangkan
  validasi token di endpoint sync.
- Kalau fitur yang disentuh punya pembagian role (admin/viewer, atau
  RBAC OP/FA di fitur finance/reconciliation) — pertahankan pembagian
  scope akses existing, jangan diperluas/dipersempit tanpa instruksi
  eksplisit dari user.
- `/users` dan `/server-monitor` admin-only — pola pengecekannya ada di
  `Sidebar.jsx` (bukan di level route `ProtectedRoute`), ikuti pola yang
  sama kalau menambah halaman admin-only baru.
