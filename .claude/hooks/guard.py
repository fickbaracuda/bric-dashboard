#!/usr/bin/env python3
"""
.claude/hooks/guard.py

PreToolUse hook (Bash, PowerShell, Edit, Write) — deterministic hard-safety
net untuk BRIC Dashboard. Hanya menegakkan aturan yang BISA dicek dari teks
command / path tanpa perlu business judgment (lihat .claude/rules/ untuk
aturan yang butuh reasoning, itu TIDAK ditegakkan di sini).

Exit code 2 = BLOCK (stderr ditampilkan ke Claude sebagai alasan).
Exit code 0 = izinkan.

Tidak pernah membaca/menyimpan credential apa pun. Hanya mencocokkan pola teks.
"""

import json
import re
import sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)  # tidak bisa parse input -> jangan block, biar tool lain yang urus

tool_name = payload.get("tool_name", "")
tool_input = payload.get("tool_input", {}) or {}

SAFETY_SCRIPTS = (
    "scripts/safe_deploy.py",
    "scripts/backup_db.py",
    "scripts/deploy_common.py",
)


def block(reason: str):
    print(reason, file=sys.stderr)
    sys.exit(2)


# ── Bash / PowerShell: cek teks command ──────────────────────────────────
if tool_name in ("Bash", "PowerShell"):
    cmd = tool_input.get("command", "") or ""
    low = cmd.lower()

    # 1) git push --force / -f (semua varian, termasuk --force-with-lease)
    if re.search(r"git\s+push", low) and re.search(r"(--force\b|--force-with-lease\b|(?<!\S)-f\b)", low):
        block(
            "BLOCKED: git push --force/-f tidak boleh dijalankan oleh AI. "
            "Kalau memang perlu, minta Authorized Release Maintainer (owner/febri) "
            "menjalankannya sendiri langsung di terminal mereka."
        )

    # 2) git reset --hard
    if re.search(r"git\s+reset\s+.*--hard", low):
        block(
            "BLOCKED: git reset --hard tidak boleh dijalankan oleh AI (bisa menghapus "
            "pekerjaan yang belum di-commit, termasuk milik developer lain). "
            "Cek 'git status' dan stash/commit dulu, atau minta user menjalankan sendiri "
            "kalau memang sengaja mau membuang perubahan."
        )

    # 3) git clean -f / -fd (hapus untracked files paksa)
    if re.search(r"git\s+clean\s+.*-[a-z]*f", low):
        block(
            "BLOCKED: git clean -f tidak boleh dijalankan oleh AI (bisa menghapus file "
            "untracked milik developer lain tanpa cara mundur)."
        )

    # 4) --no-verify / --no-gpg-sign / bypass gpg sign via -c
    if re.search(r"--no-verify\b|--no-gpg-sign\b|commit\.gpgsign=false", low):
        block(
            "BLOCKED: melewati git hook/signing (--no-verify / --no-gpg-sign / "
            "commit.gpgsign=false) tidak diizinkan. Perbaiki penyebab hook gagal, "
            "jangan dilewati."
        )

    # 5) pkill/killall node, atau Windows taskkill node.exe — proximity-bound
    #    (bukan sekadar kedua kata muncul di mana saja, supaya tidak
    #    false-positive pada teks yang MEMBAHAS aturan ini, mis. commit message).
    if re.search(r"\bpkill\b(?:\s+\S+){0,4}\s*node|\bkillall\b(?:\s+\S+){0,2}\s*node|taskkill\s+.*node\.exe", low):
        block(
            "BLOCKED: mematikan proses node secara paksa (pkill/killall/taskkill) "
            "tidak diizinkan. Backend HANYA boleh direstart lewat "
            "'sudo -u admin pm2 reload bric-backend' (via scripts/safe_deploy.py)."
        )

    # 6) nohup node ... (bypass PM2) — proximity-bound, lihat catatan di atas.
    if re.search(r"\bnohup\b(?:\s+\S+){0,4}\s*node", low):
        block(
            "BLOCKED: menjalankan node manual lewat nohup (bypass PM2) tidak diizinkan. "
            "Backend HANYA boleh dikelola lewat PM2 sebagai user admin."
        )

    # 7) staging/commit file .env asli (bukan .env.example / .env.deploy.example)
    if re.search(r"git\s+add\b", low) and re.search(r"(?<!\.example)(?<!deploy\.example)\.env(\.[a-z]+)?\b", low):
        # izinkan eksplisit .env.example / .env.deploy.example
        if not re.search(r"\.env\.example\b|\.env\.deploy\.example\b", low) or re.search(r"\.env\b(?!\.example|\.deploy)", low):
            block(
                "BLOCKED: 'git add' menyentuh file .env (kemungkinan berisi credential asli). "
                "File .env TIDAK BOLEH masuk Git. Kalau ini false positive (mis. .env.example), "
                "jalankan 'git add' dengan path eksplisit tanpa wildcard yang menyentuh .env asli."
            )

    # 8) otomatisasi gerbang konfirmasi manual (BACKUP/MIGRATE/DEPLOY) via pipe/redirect/expect.
    #    Dicek PER STATEMENT (dipisah newline/&&/||/;), dan HARUS berupa EKSEKUSI script-nya
    #    (python .../safe_deploy.py, dst) yang diberi stdin lewat pipe/redirect/expect —
    #    bukan sekadar command LAIN (git diff/grep/cat/ls) yang menyebut nama filenya sebagai
    #    argumen, dan bukan sekadar teks (mis. pesan commit git) yang mendeskripsikan aturan ini.
    safety_script_pattern = r"(?:scripts/safe_deploy\.py|scripts/backup_db\.py|\S*_migration_remote\.py)"
    statements = re.split(r"&&|\|\||;|\n", cmd)
    for stmt in statements:
        invokes_safety_script = re.search(rf"python\d?(\.exe)?\s+\S*{safety_script_pattern}", stmt)
        if not invokes_safety_script:
            continue
        stmt_low = stmt.lower()
        fed_stdin = (
            re.search(r"\|\s*python", stmt_low)  # sesuatu di-pipe MASUK ke invocation python ini
            or re.search(rf"{safety_script_pattern}\S*[^|]*<", stmt_low)  # redirect stdin < setelah nama script
            or "expect" in stmt_low
            or re.search(r"\byes\b\s", stmt_low)
        )
        if fed_stdin:
            block(
                "BLOCKED: terdeteksi upaya mengotomatisasi gerbang konfirmasi manual "
                "(BACKUP/MIGRATE/DEPLOY) lewat pipe/redirect/expect/yes pada baris: "
                f"{stmt.strip()[:200]!r}. Gerbang ini SENGAJA harus diketik manual oleh "
                "Authorized Release Maintainer di terminal mereka sendiri. Berhenti di sini "
                "dan minta user mengetik konfirmasinya langsung."
            )

    # 9) SSH langsung ke server produksi lalu edit source di sana (bukan lewat safe_deploy.py)
    is_prod_ssh = "bric-prod" in low or "147.139.201.43" in cmd
    if is_prod_ssh and re.search(r"\bnano\b|\bvim?\b|\bsed\s+-i\b|>>?\s*\S*(backend/src|frontend/src)", low):
        block(
            "BLOCKED: mengedit source code production langsung lewat SSH tidak diizinkan. "
            "Semua perubahan kode HARUS lewat git commit -> push -> scripts/safe_deploy.py. "
            "Kalau ini kondisi darurat outage, hentikan dan jelaskan situasinya ke user dulu."
        )

    # 10) SQL destruktif mentah dieksekusi LANGSUNG (psql -c / node -e), bukan sekadar
    #     disebut di teks pencarian (grep/cat pada file .sql tidak boleh false-positive).
    looks_like_direct_sql_exec = bool(
        re.search(r"\bpsql\b.*(-c\b|--command\b)", low) or re.search(r"\bnode\s+-e\b", low)
    )
    if looks_like_direct_sql_exec and re.search(r"\bdrop\s+table\b|\btruncate\s+table\b", low):
        block(
            "BLOCKED: perintah SQL destruktif (DROP TABLE / TRUNCATE) dieksekusi langsung "
            "(psql -c / node -e) terdeteksi. Migration harus lewat file .sql resmi + runner "
            "script (backend/scripts/run-*-migration.js), bukan dieksekusi ad-hoc, dan wajib "
            "backup database dulu (scripts/backup_db.py, ketik BACKUP)."
        )
    if looks_like_direct_sql_exec and re.search(r"\bdelete\s+from\b", low) and "where" not in low:
        block(
            "BLOCKED: DELETE FROM tanpa WHERE dieksekusi langsung (psql -c / node -e) — "
            "berisiko menghapus seluruh isi tabel. Kalau memang disengaja, minta user "
            "menjalankannya sendiri secara manual setelah backup database."
        )

# ── Edit / Write: lindungi file safety-gate itu sendiri ──────────────────
if tool_name in ("Edit", "Write"):
    path = tool_input.get("file_path", "") or ""
    norm = path.replace("\\", "/").lower()
    if any(norm.endswith(s) for s in SAFETY_SCRIPTS):
        block(
            f"BLOCKED: mengedit file safety-gate ({path}) tidak diizinkan lewat AI. "
            "File ini menegakkan gerbang konfirmasi manual BACKUP/MIGRATE/DEPLOY — "
            "perubahan padanya (termasuk melonggarkan validasi) harus dilakukan manual "
            "oleh Authorized Release Maintainer di luar sesi ini, dengan alasan teknis jelas."
        )

sys.exit(0)
