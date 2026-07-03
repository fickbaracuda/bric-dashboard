"""
scripts/part2d_complete_setup.py

PART 2D — Lengkapi environment variable yang hilang + kirim file safety ke
server + validasi ulang + jalankan preflight sungguhan. SEMUA dalam satu
sesi SSH supaya Anda hanya perlu mengetik password SATU KALI.

RINGKASAN YANG DILAKUKAN (urut, tidak bisa dilompati):
  A. Backup backend/.env di server (dengan timestamp, permission dijaga sama)
  B. Tambahkan HANYA 3 key yang sebelumnya terbukti belum ada:
       NODE_ENV=production
       ALLOWED_ORIGIN=https://bmsretail.my.id
       MGM_PA_SYNC_TOKEN=<diambil otomatis dari kode lokal, TIDAK PERNAH ditampilkan>
     Key yang SUDAH ADA tidak akan disentuh/ditimpa sama sekali.
  C. Kirim file "safety tooling" (scripts/, preflight-check.js, env.js, docs,
     .gitignore, backend/.env.example) via SFTP — file spesifik saja, BUKAN
     lewat git push/pull, dan BUKAN folder frontend/backend penuh.
  D. Validasi ulang server (read-only): health, PM2 list, env, node/npm, repo/frontend.
  E. Jalankan backend/scripts/preflight-check.js sungguhan (--production) di server.

TIDAK PERNAH melakukan (tidak ada satu baris kode pun untuk ini di file ini):
  - overwrite /var/www/bric
  - git pull / git push
  - npm run build
  - pm2 reload / pm2 restart / pkill
  - migration database / perintah SQL apa pun
  - mengubah konfigurasi Nginx atau reload Nginx
  - menampilkan isi/nilai backend/.env, backup-nya, atau token MGM PA

CARA PAKAI:
  python scripts/part2d_complete_setup.py

Password SSH ditanya LANGSUNG di terminal ini (getpass, tidak terlihat saat
diketik), TIDAK PERNAH disimpan ke file, TIDAK PERNAH diminta lewat chat AI.
Script akan menampilkan rencana lengkap dulu dan minta Anda mengetik
'LANJUT' sebelum melakukan perubahan apa pun.
"""

import re
import sys
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deploy_common import get_deploy_config, connect_ssh, run_remote, mask  # noqa: E402

ROOT_DIR = Path(__file__).resolve().parent.parent

# Daftar file yang dikirim ke server — EKSPLISIT satu-satu (bukan copy folder
# penuh), supaya tidak mungkin ada file lain (termasuk .env / backup / dump)
# ikut terkirim tanpa sengaja.
SAFETY_FILES = [
    "scripts/deploy_common.py",
    "scripts/backup_db.py",
    "scripts/safe_deploy.py",
    "scripts/check_server_readonly.py",
    "scripts/part2d_complete_setup.py",
    "backend/scripts/preflight-check.js",
    "backend/src/config/env.js",
    "docs/DEPLOYMENT_SAFETY.md",
    ".gitignore",
    "backend/.env.example",
]

ENV_KEYS_TO_VERIFY = [
    "JWT_SECRET", "DATABASE_URL", "APPS_SCRIPT_TOKEN", "MGM_PA_SYNC_TOKEN",
    "ADMIN_PASSWORD", "VIEWER_PASSWORD", "ALLOWED_ORIGIN", "GEMINI_API_KEY", "NODE_ENV",
]


def get_local_mgm_token():
    """
    Ambil nilai token MGM PA yang SUDAH ADA di kode lokal (backend/src/routes/warroom.js),
    BUKAN membuat token baru. Nilai ini TIDAK PERNAH di-print/ditampilkan di mana pun —
    hanya dipakai langsung secara internal untuk mengisi environment variable di server.
    """
    warroom_path = ROOT_DIR / "backend" / "src" / "routes" / "warroom.js"
    if not warroom_path.exists():
        return None
    content = warroom_path.read_text(encoding="utf-8")
    m = re.search(
        r"MGM_SYNC_TOKEN\s*=\s*process\.env\.MGM_PA_SYNC_TOKEN\s*\|\|\s*'([^']*)'",
        content,
    )
    return m.group(1) if m else None


def check_env_key(client, remote_project, key):
    out, _, _ = run_remote(
        client, f"grep -q '^{key}=' {remote_project}/backend/.env && echo ADA || echo TIDAK_ADA"
    )
    return out.strip()


def append_env_key(client, remote_project, key, value):
    """Tambahkan 1 baris KEY=VALUE ke akhir backend/.env dengan aman:
    - Selalu APPEND (>>), tidak pernah menimpa (>) seluruh file.
    - Menjamin baris baru dimulai di baris baru sendiri, walau file lama
      tidak diakhiri newline (supaya tidak menyambung ke baris terakhir lama).
    - Value di-escape aman untuk single-quote shell.
    """
    safe_value = value.replace("'", "'\\''")
    cmd = (
        f"cd {remote_project} && "
        f"( [ -s backend/.env ] && [ \"$(tail -c1 backend/.env)\" != \"\" ] && echo >> backend/.env ; "
        f"printf '%s\\n' '{key}={safe_value}' >> backend/.env ) && echo APPEND_OK"
    )
    out, err, code = run_remote(client, cmd)
    return "APPEND_OK" in out


def main():
    print("==============================================================")
    print("  BRIC DASHBOARD — PART 2D: LENGKAPI ENV + KIRIM FILE SAFETY")
    print("==============================================================")
    print("Rencana (urut, semua di dalam SATU sesi SSH):")
    print("  A. Backup backend/.env di server (timestamp, permission dijaga)")
    print("  B. Tambahkan HANYA key yang belum ada: NODE_ENV, ALLOWED_ORIGIN, MGM_PA_SYNC_TOKEN")
    print("     (key yang sudah ada TIDAK akan diubah/ditimpa)")
    print("  C. Kirim file safety via SFTP (file spesifik saja, BUKAN git, BUKAN folder penuh)")
    print("  D. Validasi ulang server (read-only)")
    print("  E. Jalankan preflight-check.js sungguhan (--production, read-only)")
    print()
    print("TIDAK melakukan: overwrite /var/www/bric, git pull/push, npm run build,")
    print("pm2 reload/restart, pkill, migration, ubah/reload Nginx.")
    print()

    confirm = input("Ketik 'LANJUT' untuk memulai, apa saja selain itu untuk batal: ").strip()
    if confirm != "LANJUT":
        print("Dibatalkan. Tidak ada perubahan yang dilakukan.")
        return

    # Ambil nilai token MGM PA dari kode lokal DULU, sebelum minta password sama sekali.
    # Kalau tidak ketemu, berhenti total tanpa perlu koneksi ke server.
    mgm_token_value = get_local_mgm_token()
    if mgm_token_value is None:
        print("\n[STOP] Tidak bisa menemukan nilai token MGM PA yang sudah ada di kode lokal")
        print("       (backend/src/routes/warroom.js). Sesuai instruksi, PROSES DIHENTIKAN.")
        print("       Tidak ada koneksi ke server yang dibuka. Silakan pilih metode input")
        print("       aman lain untuk MGM_PA_SYNC_TOKEN.")
        return
    print("[OK] Nilai token MGM PA berhasil dibaca dari kode lokal (nilai TIDAK ditampilkan).")

    config = get_deploy_config(interactive=True)
    remote_project = config["REMOTE_PROJECT_PATH"]
    remote_frontend = config["REMOTE_FRONTEND_PATH"]

    print(f"\n>>> Menyambung ke server {mask(config['VPS_HOST'])} ...")
    client = connect_ssh(config)

    try:
        # ================= STEP A: BACKUP =================
        print("\n=== [A] Backup backend/.env ===")
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = f"{remote_project}/backend/.env.backup.{timestamp}"
        out, err, code = run_remote(
            client, f"cd {remote_project} && cp -p backend/.env {backup_path} && echo BACKUP_OK"
        )
        if "BACKUP_OK" not in out:
            print("[STOP] Gagal membuat backup .env. PROSES DIHENTIKAN — tidak ada perubahan lain dilakukan.")
            print(f"       (pesan error tidak menampilkan isi file): {err.strip()[:300]}")
            return
        print(f"[OK] Backup dibuat: {backup_path}")

        # Verifikasi backup: bandingkan jumlah baris & permission, TANPA membuka isi file.
        out1, _, _ = run_remote(client, f"wc -l < {remote_project}/backend/.env")
        out2, _, _ = run_remote(client, f"wc -l < {backup_path}")
        print(f"     Jumlah baris — asli: {out1.strip()}, backup: {out2.strip()} (harus sama)")
        out3, _, _ = run_remote(client, f"stat -c '%a' {remote_project}/backend/.env {backup_path}")
        print(f"     Permission (asli, backup): {out3.strip().splitlines()}")

        # ================= STEP B: TAMBAHKAN ENV YANG HILANG =================
        print("\n=== [B] Cek & lengkapi environment variable yang hilang ===")
        keys_to_add = {
            "NODE_ENV": "production",
            "ALLOWED_ORIGIN": "https://bmsretail.my.id",
            "MGM_PA_SYNC_TOKEN": mgm_token_value,
        }
        for key, value in keys_to_add.items():
            status = check_env_key(client, remote_project, key)
            if status == "ADA":
                print(f"   [LEWATI] {key} sudah ada di server — TIDAK diubah/ditimpa.")
                continue
            shown_value = value if key != "MGM_PA_SYNC_TOKEN" else "(dari kode lokal, tidak ditampilkan)"
            print(f"   [TAMBAH] {key} = {shown_value}")
            ok = append_env_key(client, remote_project, key, value)
            if not ok:
                print(f"   [GAGAL] Menambahkan {key}. Backup tetap aman di: {backup_path}")
                continue
            new_status = check_env_key(client, remote_project, key)
            label = "ADA" if new_status == "ADA" else "TIDAK ADA"
            print(f"   [VERIFIKASI] {key} -> {label}")

        # ================= STEP C: KIRIM FILE SAFETY =================
        print("\n=== [C] Kirim file safety ke server (SFTP, file spesifik saja) ===")
        for d in ("scripts", "backend/scripts", "backend/src/config", "docs"):
            run_remote(client, f"mkdir -p {remote_project}/{d}")
        sftp = client.open_sftp()
        for rel_path in SAFETY_FILES:
            local_path = ROOT_DIR / rel_path
            remote_path = f"{remote_project}/{rel_path}"
            if not local_path.exists():
                print(f"   [LEWATI] {rel_path} tidak ditemukan di lokal.")
                continue
            out, _, _ = run_remote(client, f"[ -f {remote_path} ] && echo ADA || echo TIDAK_ADA")
            if out.strip() == "ADA":
                run_remote(client, f"cp -p {remote_path} {remote_path}.backup.{timestamp}")
            sftp.put(str(local_path), remote_path)
            local_size = local_path.stat().st_size
            remote_size = sftp.stat(remote_path).st_size
            match = "OK" if local_size == remote_size else "UKURAN BEDA, CEK MANUAL"
            print(f"   [{match}] {rel_path} ({remote_size} bytes)")
        sftp.close()

        # ================= STEP D: VALIDASI ULANG =================
        print("\n=== [D] Validasi ulang server (read-only) ===")
        out, _, _ = run_remote(client, "curl -s http://localhost:3001/health")
        print(f"   Health: {out.strip()}")
        out, _, _ = run_remote(client, "sudo -u admin pm2 list 2>&1")
        print(out.strip())
        out, _, _ = run_remote(client, "node --version 2>&1; npm --version 2>&1")
        print(f"   Node/npm: {out.strip()}")
        out, _, _ = run_remote(client, f"[ -d {remote_project} ] && echo ADA || echo TIDAK_ADA")
        print(f"   Repo: {out.strip()}")
        out, _, _ = run_remote(client, f"[ -d {remote_frontend} ] && echo ADA || echo TIDAK_ADA")
        print(f"   Frontend: {out.strip()}")
        print("   Status env terbaru:")
        for key in ENV_KEYS_TO_VERIFY:
            status = check_env_key(client, remote_project, key)
            label = "ADA" if status == "ADA" else "TIDAK ADA"
            print(f"     {key} -> {label}")

        # ================= STEP E: PREFLIGHT SUNGGUHAN =================
        print("\n=== [E] Jalankan preflight-check.js sungguhan (--production, read-only) ===")
        out, _, _ = run_remote(
            client, f"[ -f {remote_project}/backend/scripts/preflight-check.js ] && echo ADA || echo TIDAK_ADA"
        )
        if out.strip() != "ADA":
            print("   [INFO] preflight-check.js tidak ditemukan di server (pengiriman di [C] mungkin gagal).")
        else:
            out, err, code = run_remote(
                client,
                f"cd {remote_project} && node backend/scripts/preflight-check.js --production 2>&1",
                timeout=60,
            )
            print(out.strip() or f"[tidak ada output] {err.strip()}")

        print("\n=== SELESAI. Tidak ada migration, tidak ada reload PM2/Nginx, ")
        print("    tidak ada overwrite /var/www/bric, tidak ada git pull/push. ===")

    finally:
        client.close()


if __name__ == "__main__":
    main()
