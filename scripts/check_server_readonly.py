"""
scripts/check_server_readonly.py

PART 2B/2C — Pengecekan server SECARA READ-ONLY (hanya membaca, tidak mengubah apa pun).

Script ini HANYA menjalankan perintah berikut (semua read-only, tidak ada
satu pun yang mengubah/menulis apa pun di server):
  1. Cek folder repo ada:            [ -d /home/admin/bric-dashboard ]
  2. Cek folder frontend ada:        [ -d /var/www/bric ]
  3. Status PM2 (LIST saja, bukan reload/restart): sudo -u admin pm2 list
  4. Kesehatan backend:              curl -s http://localhost:3001/health
  5. Versi Node & npm:               node --version ; npm --version
  6. Cek file backend/.env ADA atau TIDAK (isinya TIDAK pernah dibuka)
  7. Cek NAMA key environment yang ada/tidak ada di backend/.env (bukan isinya)
  8. Test konfigurasi Nginx TANPA reload: nginx -t
  9. Kalau file backend/scripts/preflight-check.js SUDAH ADA di server,
     jalankan (read-only, tidak reload PM2/build/migration apa pun):
     node backend/scripts/preflight-check.js --production
     Kalau file itu BELUM ADA (karena belum pernah di-deploy/push ke
     server), langkah ini otomatis dilewati dengan penjelasan — bukan error.

SECARA EKSPLISIT DILARANG dan TIDAK ADA di script ini:
  git pull, npm run build, cp/mv/rm, pm2 reload, pm2 restart, pkill,
  service nginx reload, systemctl restart, migration, perintah SQL apa pun
  yang menulis data.

STATUS yang dipakai untuk tiap env key: ADA / TIDAK ADA / TIDAK BISA DIPASTIKAN
(TIDAK BISA DIPASTIKAN dipakai kalau file .env-nya sendiri tidak ditemukan,
jadi key di dalamnya tidak bisa dicek sama sekali).

Cara pakai:
  python scripts/check_server_readonly.py

Password SSH akan ditanya LANGSUNG di terminal ini (getpass, tidak terlihat
saat diketik). Password TIDAK PERNAH ditulis ke file apa pun, TIDAK PERNAH
ditampilkan di layar, dan TIDAK PERNAH diminta lewat chat/prompt AI.
"""

import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deploy_common import get_deploy_config, connect_ssh, run_remote, mask  # noqa: E402

# Key environment variable yang dicek KEBERADAANNYA saja (bukan isinya) di backend/.env.
ENV_KEYS_TO_CHECK = [
    "JWT_SECRET",
    "DATABASE_URL",
    "APPS_SCRIPT_TOKEN",
    "MGM_PA_SYNC_TOKEN",
    "ADMIN_PASSWORD",
    "VIEWER_PASSWORD",
    "ALLOWED_ORIGIN",
    "GEMINI_API_KEY",
    "NODE_ENV",
]


def main():
    print("==============================================================")
    print("  BRIC DASHBOARD — CEK SERVER READ-ONLY (Part 2C)")
    print("==============================================================")
    print("Script ini HANYA membaca kondisi server. TIDAK ADA perubahan apa pun.")
    print("Tidak ada git pull, tidak ada build, tidak ada copy/hapus file,")
    print("tidak ada reload/restart PM2, tidak ada reload Nginx, tidak ada migration.")
    print()
    print("Password SSH akan ditanya di bawah ini. Ketik langsung di terminal ini —")
    print("tidak akan terlihat di layar, dan TIDAK disimpan ke file mana pun.")
    print()

    config = get_deploy_config(interactive=True)
    remote_project = config["REMOTE_PROJECT_PATH"]
    remote_frontend = config["REMOTE_FRONTEND_PATH"]

    print(f"\n>>> Menyambung ke server {mask(config['VPS_HOST'])} (read-only) ...")
    client = connect_ssh(config)

    try:
        print("\n1) Cek folder repo di server:")
        out, _, _ = run_remote(client, f"[ -d {remote_project} ] && echo ADA || echo TIDAK_ADA")
        print(f"   {remote_project} -> {out.strip()}")

        print("\n2) Cek folder frontend production:")
        out, _, _ = run_remote(client, f"[ -d {remote_frontend} ] && echo ADA || echo TIDAK_ADA")
        print(f"   {remote_frontend} -> {out.strip()}")

        print("\n3) Status PM2 (list saja, TIDAK reload/restart):")
        out, err, code = run_remote(client, "sudo -u admin pm2 list 2>&1")
        print(out.strip() or f"[tidak ada output] {err.strip()}")

        print("\n4) Cek kesehatan backend (http://localhost:3001/health):")
        out, err, code = run_remote(client, "curl -s -w '\\nHTTP_CODE:%{http_code}' http://localhost:3001/health")
        print(f"   Response: {out.strip()}")

        print("\n5) Cek Node.js & npm di server:")
        out, _, _ = run_remote(client, "node --version 2>&1; npm --version 2>&1")
        print(f"   {out.strip()}")

        print("\n6) Cek keberadaan file backend/.env di server (isinya TIDAK dibuka):")
        out, _, _ = run_remote(
            client, f"[ -f {remote_project}/backend/.env ] && echo ADA || echo TIDAK_ADA"
        )
        env_exists = "ADA" == out.strip()
        print(f"   backend/.env -> {out.strip()}")

        print("\n7) Cek NAMA key environment penting (TIDAK ADA nilai yang ditampilkan):")
        if not env_exists:
            for key in ENV_KEYS_TO_CHECK:
                print(f"   [TIDAK BISA DIPASTIKAN]  {key} -> file backend/.env tidak ditemukan")
        else:
            for key in ENV_KEYS_TO_CHECK:
                out, err, code = run_remote(
                    client,
                    f"grep -q '^{key}=' {remote_project}/backend/.env && echo ADA || echo TIDAK_ADA",
                )
                status = out.strip() if out.strip() in ("ADA", "TIDAK_ADA") else "TIDAK_BISA_DIPASTIKAN"
                label = {"ADA": "ADA", "TIDAK_ADA": "TIDAK ADA", "TIDAK_BISA_DIPASTIKAN": "TIDAK BISA DIPASTIKAN"}[status]
                mark = "[OK]     " if status == "ADA" else "[PERHATIAN] "
                print(f"   {mark}{key} -> {label}")

        print("\n8) Test konfigurasi Nginx TANPA reload (nginx -t):")
        out, err, code = run_remote(client, "nginx -t 2>&1")
        print(f"   {(out + err).strip() or '(tidak ada output)'}")

        print("\n9) Cek & jalankan preflight-check.js di server (read-only, --production):")
        out, _, _ = run_remote(
            client, f"[ -f {remote_project}/backend/scripts/preflight-check.js ] && echo ADA || echo TIDAK_ADA"
        )
        if out.strip() == "ADA":
            out, err, code = run_remote(
                client,
                f"cd {remote_project} && node backend/scripts/preflight-check.js --production 2>&1",
                timeout=60,
            )
            print(out.strip() or f"[tidak ada output] {err.strip()}")
        else:
            print("   [INFO] backend/scripts/preflight-check.js BELUM ADA di server.")
            print("   Ini NORMAL, bukan error — file ini baru dibuat di Part 2A/2B dan")
            print("   memang belum pernah di-deploy/push ke server (sesuai aturan: belum")
            print("   ada deploy apa pun). Pengecekan ini baru bisa jalan nyata di server")
            print("   setelah file ini ikut ter-deploy (Part 2D).")

        print("\n=== Selesai. Tidak ada satu pun perubahan yang dilakukan ke server. ===")

    finally:
        client.close()


if __name__ == "__main__":
    main()
