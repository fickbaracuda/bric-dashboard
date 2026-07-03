"""
scripts/safe_deploy.py

PART 2A — Draft script deploy AMAN untuk BRIC Dashboard.

STATUS: DIBUAT UNTUK DISIAPKAN DULU. BELUM DIJALANKAN KE PRODUCTION.
Jangan jalankan dengan --execute sebelum diuji & disetujui pemilik project.

MODE DEFAULT = DRY-RUN (rencana saja):
  python scripts/safe_deploy.py
  python scripts/safe_deploy.py --dry-run     (sama saja, ditulis eksplisit)
  -> HANYA menampilkan langkah apa saja yang AKAN dilakukan.
  -> TIDAK menyambung ke server sama sekali. Aman dijalankan kapan saja.

MODE EXECUTE (baru dipakai nanti, setelah disetujui):
  python scripts/safe_deploy.py --execute
  -> Akan diminta mengetik "DEPLOY" dulu sebagai konfirmasi terakhir.
  -> Baru setelah itu benar-benar menyambung ke server dan menjalankan langkah.

URUTAN 8 LANGKAH INTI (sesuai kesepakatan keamanan):
  1. Cek status Git di server (+ tarik kode terbaru / git pull) — kalau ada
     perubahan yang belum di-commit di server, BERHENTI, jangan diam-diam ditimpa
  2. Jalankan preflight check di server (--production)
     -> Kalau preflight GAGAL, PROSES BERHENTI DI SINI. Tidak lanjut ke langkah manapun di bawah.
  3. Build frontend di server (npm run build)
     -> Kalau build GAGAL, PROSES BERHENTI. Tidak ada file yang disalin ke production.
  4. Backup folder frontend production (/var/www/bric) sebelum ditimpa
  5. Copy hasil build ke /var/www/bric
  6. Reload backend LEWAT PM2: "sudo -u admin pm2 reload bric-backend"
     (TIDAK PERNAH pakai pkill, TIDAK PERNAH menjalankan node manual sebagai root)
  7. Cek http://localhost:3001/health
  8. Kalau langkah 7 gagal -> tampilkan instruksi rollback frontend (dari folder backup langkah 4)
"""

import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deploy_common import get_deploy_config, connect_ssh, run_remote, mask  # noqa: E402

PM2_RELOAD_COMMAND = "sudo -u admin pm2 reload bric-backend"
HEALTH_CHECK_URL = "http://localhost:3001/health"
PM2_APP_NAME = "bric-backend"

# Path yang SUDAH KITA KETAHUI adalah file "safety tooling" (dikirim manual
# lewat SFTP di Part 2D, bukan lewat git). Hanya folder yang BENAR-BENAR BARU
# (tidak ada isinya sebelum Part 2D) yang aman dipakai sebagai prefix — folder
# "backend/scripts/" SUDAH ADA SEBELUMNYA (berisi file lain juga), jadi harus
# dicocokkan per file, bukan per folder, supaya file lain di folder itu tidak
# ikut lolos begitu saja.
KNOWN_SAFETY_PREFIXES = (
    "scripts/",
    "backend/src/config/",
    "docs/",
)
KNOWN_SAFETY_EXACT_BASES = (
    ".gitignore",
    "backend/.env.example",
    "backend/scripts/preflight-check.js",
)

# Path yang SUDAH DIKONFIRMASI LANGSUNG oleh pemilik project (Part 2E,
# 2026-07-02) sebagai file fitur yang MEMANG SUDAH sengaja di-deploy
# sebelumnya dan sedang berjalan di production — hanya belum sempat
# di-commit ke Git. INI BUKAN "safety tooling" — ini dicatat terpisah
# supaya jelas kenapa file-file ini diizinkan (bukan aturan umum, tapi
# konfirmasi eksplisit untuk snapshot kondisi server per tanggal ini).
# Begitu file-file ini betulan di-commit ke Git di kemudian hari, baris-baris
# ini otomatis tidak relevan lagi (tidak akan muncul lagi di git status).
USER_CONFIRMED_PREEXISTING_PATHS = (
    "backend/src/app.js",
    "backend/src/routes/warroom-ekspedisi.js",
    "backend/src/routes/warroom-qris-control-tower.js",
    "backend/src/migrations/create_ekspedisi_monthly.sql",
    "backend/src/migrations/create_ekspedisi_outlet_status.sql",
    "backend/src/migrations/create_qris_control_tower.sql",
    "backend/data/",
    "backend/scripts/qa-perf-check.js",
    "backend/scripts/qa-real-data.js",
    "backend/scripts/run-ekspedisi-migration.js",
    "backend/scripts/run-ekspedisi-outlet-status-migration.js",
    "backend/scripts/run-qris-ctrl-migration.js",
    "backend/scripts/test-qris-control-tower.js",
    "frontend/src/App.jsx",
    "frontend/src/components/Sidebar.jsx",
    "frontend/src/index.css",
    "frontend/src/services/api.js",
    "frontend/src/pages/WarRoomEkspedisi.jsx",
    "frontend/src/pages/WarRoomPaLpd.jsx",
    "frontend/src/pages/WarRoomQrisControlTower.jsx",
    "frontend/src/components/qris/",
)


def is_known_safety_path(path: str) -> bool:
    path = path.strip()
    for prefix in KNOWN_SAFETY_PREFIXES:
        if path.startswith(prefix) or path == prefix:
            return True
    for base in KNOWN_SAFETY_EXACT_BASES:
        if path == base or path.startswith(base + ".backup."):
            return True
    return False


def is_user_confirmed_preexisting_path(path: str) -> bool:
    path = path.strip()
    for known in USER_CONFIRMED_PREEXISTING_PATHS:
        if path == known or (known.endswith("/") and path.startswith(known)):
            return True
    return False


def parse_git_status_paths(porcelain_output: str):
    """Ambil daftar path file dari output 'git status --porcelain'."""
    paths = []
    for line in porcelain_output.splitlines():
        if not line.strip():
            continue
        # format umum: 'XY path' atau 'XY old -> new' untuk rename
        rest = line[3:] if len(line) > 3 else line.strip()
        if " -> " in rest:
            rest = rest.split(" -> ", 1)[1]
        paths.append(rest.strip().strip('"'))
    return paths


def get_pm2_restart_count(client) -> "int | None":
    """Ambil jumlah restart PM2 untuk proses bric-backend. None kalau gagal dibaca."""
    out, _, code = run_remote(client, f"sudo -u admin pm2 jlist 2>/dev/null")
    if code != 0 or not out.strip():
        return None
    try:
        import json
        data = json.loads(out)
        for proc in data:
            if proc.get("name") == PM2_APP_NAME:
                return proc.get("pm2_env", {}).get("restart_time")
    except Exception:
        return None
    return None

STEPS_PLAN = [
    "0. Catat kondisi awal: restart count PM2, commit HEAD, health -> STOP kalau sudah tidak sehat dari awal",
    "1. Cek status Git di server (file safety yang dikenal -> lanjut; file lain tak dikenal -> STOP) + git pull",
    "   -> STOP juga kalau git pull ternyata menarik commit BARU (berarti bukan 'deploy kosong' lagi)",
    "2. Jalankan preflight check di server (--production) -> STOP kalau status FAIL",
    "3. Build frontend di server (npm run build) -> STOP kalau gagal, TIDAK ada file disalin",
    "4. Backup folder /var/www/bric (frontend production) sebelum ditimpa",
    "5. Copy hasil build baru ke /var/www/bric",
    f"6. Reload backend via PM2 (user admin): {PM2_RELOAD_COMMAND}",
    f"7. Cek kesehatan backend: {HEALTH_CHECK_URL}",
    "8. Verifikasi akhir: PM2 tetap user admin, restart count naik wajar (persis +1)",
]


def print_plan():
    print("==============================================================")
    print("  BRIC DASHBOARD — SAFE DEPLOY (Part 2A draft)")
    print("==============================================================")
    print("Rencana langkah yang akan dijalankan (urutan tetap, tidak boleh dilompati):")
    for step in STEPS_PLAN:
        print(f"   {step}")
    print()
    print("Aturan keras yang dipatuhi script ini:")
    print("   - TIDAK PERNAH memakai 'pkill'")
    print("   - TIDAK PERNAH menjalankan backend manual sebagai root (nohup dkk)")
    print("   - Restart backend HANYA lewat perintah PM2 resmi di atas, sebagai user 'admin'")
    print("   - Kalau build frontend gagal, TIDAK lanjut menyalin/deploy apa pun")
    print("   - Frontend lama di-backup dulu sebelum ditimpa")
    print()


def backup_frontend(client, remote_frontend_path: str) -> str:
    """Backup folder frontend production sebelum ditimpa. Return path folder backup."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = f"{remote_frontend_path.rstrip('/')}_backup_{timestamp}"
    print(f">>> Membuat backup frontend: {backup_path}")
    out, err, code = run_remote(
        client, f"cp -r {remote_frontend_path} {backup_path} && echo BACKUP_OK", timeout=120
    )
    if "BACKUP_OK" not in out:
        raise RuntimeError(f"Gagal membuat backup frontend. Detail: {err or out}")
    print(f"[OK] Backup frontend tersimpan di: {backup_path}")
    return backup_path


def run_deploy(config: dict):
    remote_project = config["REMOTE_PROJECT_PATH"]
    remote_frontend = config["REMOTE_FRONTEND_PATH"]

    print(f">>> Menyambung ke server {mask(config['VPS_HOST'])} ...")
    client = connect_ssh(config)

    try:
        # 0) Catat kondisi AWAL sebelum menyentuh apa pun (untuk dibandingkan nanti)
        print("\n>>> [0/8] Catat kondisi awal (sebelum ada perubahan apa pun) ...")
        restart_before = get_pm2_restart_count(client)
        print(f"   Jumlah restart PM2 SEBELUM deploy: {restart_before if restart_before is not None else 'tidak bisa dibaca'}")
        out, _, _ = run_remote(client, f"cd {remote_project} && git rev-parse HEAD")
        head_before = out.strip()
        print(f"   Commit HEAD server SEBELUM pull: {head_before[:12]}...")
        out, _, _ = run_remote(client, f"curl -s {HEALTH_CHECK_URL}")
        print(f"   Health SEBELUM deploy: {out.strip()}")
        if "ok" not in out.lower():
            print("[STOP] Backend TIDAK sehat SEBELUM deploy dimulai. Deploy DIBATALKAN.")
            print("       Ini bukan disebabkan oleh script ini — server memang sudah bermasalah duluan.")
            return False

        # 1) Cek git status dulu — bedakan 3 kategori:
        #    a) file safety tooling yang MEMANG kita kirim manual (Part 2D, lewat SFTP)
        #    b) file fitur yang SUDAH DIKONFIRMASI pemilik project sebagai kondisi
        #       production yang memang disengaja (Part 2E, 2026-07-02)
        #    c) apa pun di luar (a) dan (b) -> STOP, tidak dikenal sama sekali
        print("\n>>> [1/8] Cek status Git di server ...")
        out, err, code = run_remote(client, f"cd {remote_project} && git status --porcelain")
        changed_paths = parse_git_status_paths(out)
        safety_paths = [p for p in changed_paths if is_known_safety_path(p)]
        confirmed_paths = [
            p for p in changed_paths
            if not is_known_safety_path(p) and is_user_confirmed_preexisting_path(p)
        ]
        unknown_paths = [
            p for p in changed_paths
            if not is_known_safety_path(p) and not is_user_confirmed_preexisting_path(p)
        ]

        if safety_paths:
            print(f"   [INFO] {len(safety_paths)} file safety tooling belum di-commit di server")
            print("          (WAJAR, dikirim manual lewat SFTP di Part 2D, bukan lewat git):")
            for p in safety_paths:
                print(f"            - {p}")

        if confirmed_paths:
            print(f"   [INFO] {len(confirmed_paths)} file fitur yang SUDAH DIKONFIRMASI pemilik")
            print("          project (Part 2E) sebagai kondisi production yang disengaja:")
            for p in confirmed_paths:
                print(f"            - {p}")

        if unknown_paths:
            print("\n[PERINGATAN] Ditemukan perubahan file yang TIDAK DIKENALI sebagai file safety:")
            for p in unknown_paths:
                print(f"     - {p}")
            print("Proses DIHENTIKAN — ini mengindikasikan ada perubahan fitur/kode lain")
            print("yang belum jelas statusnya di server. Sesuai aturan, deploy tidak boleh")
            print("lanjut sebelum ini dikonfirmasi manual oleh pemilik project.")
            return False

        print("[OK] Tidak ada perubahan tak dikenal di server (hanya file safety yang sudah diketahui, kalau ada).")

        # 1b) git pull (masih bagian dari langkah 1: "cek status + tarik kode terbaru")
        print("\n>>> [1/8] git pull origin master ...")
        out, err, code = run_remote(client, f"cd {remote_project} && git pull origin master 2>&1", timeout=120)
        print(out.strip())
        if code != 0:
            print("[STOP] git pull gagal. Deploy dihentikan.")
            return False

        out, _, _ = run_remote(client, f"cd {remote_project} && git rev-parse HEAD")
        head_after = out.strip()
        if head_after != head_before:
            print(f"\n[PERINGATAN] git pull menarik commit BARU (HEAD berubah dari {head_before[:12]} ke {head_after[:12]}).")
            print("Ini BUKAN 'deploy kosong' lagi — ada kode baru yang belum pernah diuji lewat alur ini.")
            print("Proses DIHENTIKAN untuk konfirmasi manual sebelum melanjutkan build & deploy.")
            return False
        print(f"[OK] HEAD tidak berubah ({head_after[:12]}...) — benar-benar 'deploy kosong', tidak ada kode baru.")

        # 2) Preflight check (mode production) di server
        print("\n>>> [2/8] Menjalankan preflight check di server ...")
        out, err, code = run_remote(
            client, f"cd {remote_project} && node backend/scripts/preflight-check.js --production", timeout=60
        )
        print(out.strip())
        if code != 0:
            print("[STOP] Preflight check berstatus FAIL. Deploy DIHENTIKAN sebelum menyentuh apa pun lagi.")
            return False
        print("[OK] Preflight check lolos (PASS/WARNING, bukan FAIL).")

        # 3) Build frontend — WAJIB cek exit code
        print("\n>>> [3/8] Build frontend (npm run build) di server ...")
        out, err, code = run_remote(
            client, f"cd {remote_project}/frontend && npm run build 2>&1", timeout=300
        )
        print(out.strip()[-2000:])
        if code != 0:
            print("[STOP] Build frontend GAGAL. TIDAK ADA file yang disalin ke production.")
            print("       Frontend production yang sedang tayang TIDAK diubah.")
            return False
        # Pastikan folder dist benar-benar ada & tidak kosong
        out, err, code = run_remote(
            client, f"[ -d {remote_project}/frontend/dist ] && ls {remote_project}/frontend/dist | wc -l"
        )
        if not out.strip() or out.strip() == "0":
            print("[STOP] Folder frontend/dist kosong/tidak ada setelah build. Deploy dihentikan.")
            return False
        print("[OK] Build frontend berhasil.")

        # 4) Backup frontend production sebelum ditimpa
        print("\n>>> [4/8] Backup frontend production ...")
        backup_path = backup_frontend(client, remote_frontend)

        # 5) Copy dist ke folder production
        print("\n>>> [5/8] Menyalin hasil build ke folder production ...")
        out, err, code = run_remote(
            client,
            f"cp -r {remote_project}/frontend/dist/* {remote_frontend}/ && echo COPY_OK",
            timeout=60,
        )
        if "COPY_OK" not in out:
            print(f"[STOP] Gagal menyalin frontend. Detail: {err or out}")
            print(f"       Frontend LAMA masih ada di backup: {backup_path}")
            return False
        print("[OK] Frontend production sudah diperbarui.")

        # 6) Reload backend LEWAT PM2 (bukan pkill / nohup manual)
        print(f"\n>>> [6/8] Reload backend: {PM2_RELOAD_COMMAND}")
        out, err, code = run_remote(client, PM2_RELOAD_COMMAND, timeout=60)
        print(out.strip())
        if code != 0:
            print("[PERINGATAN] Perintah reload PM2 melaporkan error. Cek manual ke server.")

        # 7) Health check
        print(f"\n>>> [7/8] Cek kesehatan backend: {HEALTH_CHECK_URL}")
        out, err, code = run_remote(client, f"sleep 2 && curl -s {HEALTH_CHECK_URL}", timeout=30)
        print("Response:", out.strip() or "(tidak ada response)")

        if "ok" not in out.lower():
            print("\n[GAGAL] Health check TIDAK menunjukkan status sehat.")
            print("=== INSTRUKSI ROLLBACK FRONTEND ===")
            print(f"  1. SSH ke server, lalu jalankan:")
            print(f"     sudo rm -rf {remote_frontend}/*")
            print(f"     sudo cp -r {backup_path}/* {remote_frontend}/")
            print(f"  2. Backend TIDAK di-rollback otomatis oleh script ini.")
            print(f"     Kalau backend juga bermasalah, gunakan 'git log' + 'git revert' di server,")
            print(f"     lalu jalankan lagi: {PM2_RELOAD_COMMAND}")
            print(f"  3. Setelah rollback, cek lagi: curl {HEALTH_CHECK_URL}")
            return False

        # 8) Verifikasi akhir: user PM2 tetap admin + restart count naik wajar (bukan crash loop)
        print("\n>>> [8/8] Verifikasi akhir (PM2 user & jumlah restart) ...")
        out, _, _ = run_remote(client, "sudo -u admin pm2 list 2>&1")
        print(out.strip())
        restart_after = get_pm2_restart_count(client)
        print(f"   Jumlah restart PM2 SEBELUM: {restart_before if restart_before is not None else '?'}, "
              f"SESUDAH: {restart_after if restart_after is not None else '?'}")
        if restart_before is not None and restart_after is not None:
            delta = restart_after - restart_before
            if delta == 1:
                print("   [OK] Restart bertambah tepat 1 kali — sesuai satu kali reload yang kita lakukan.")
            elif delta > 1:
                print(f"   [PERHATIAN] Restart bertambah {delta} kali (lebih dari 1) — backend mungkin sempat")
                print("               crash/restart sendiri di luar reload ini. Perlu dicek log PM2 manual.")
            else:
                print("   [PERHATIAN] Jumlah restart tidak bertambah seperti yang diharapkan — cek manual.")

        print("\n>>> Deploy selesai. Backend melaporkan status sehat.")
        print(f"    (Backup frontend sebelumnya masih tersimpan di: {backup_path} — belum dihapus otomatis)")
        return True
    finally:
        client.close()


def main():
    execute_mode = "--execute" in sys.argv
    explicit_dry_run = "--dry-run" in sys.argv

    print_plan()

    if not execute_mode:
        label = "DRY-RUN (diminta eksplisit dengan --dry-run)" if explicit_dry_run else "DRY-RUN (mode default)"
        print(f"Mode saat ini: {label} — hanya menampilkan rencana di atas.")
        print("TIDAK ADA koneksi ke server yang dibuka. TIDAK ADA yang dijalankan.")
        print("Kalau sudah siap & disetujui, jalankan ulang dengan: python scripts/safe_deploy.py --execute")
        return

    print("Mode saat ini: EXECUTE — script ini AKAN menyambung ke server sungguhan.")
    confirm = input("Ketik 'DEPLOY' (huruf besar) untuk lanjut, apa saja selain itu untuk batal: ").strip()
    if confirm != "DEPLOY":
        print("Dibatalkan. Tidak ada perubahan/aksi yang dilakukan ke server.")
        return

    config = get_deploy_config(interactive=True)
    success = run_deploy(config)

    print()
    print("=== Deploy SELESAI (sukses) ===" if success else "=== Deploy DIHENTIKAN / GAGAL — lihat pesan di atas ===")


if __name__ == "__main__":
    main()
