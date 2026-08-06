"""
scripts/run_mpng3_migration_remote.py

Jalankan migration WAR-ROOM MPNG3 di server PRODUCTION dengan aman lewat
SSH — mengikuti pola persis run_payment_agent_produk_migration_remote.py.

APA YANG DILAKUKAN SCRIPT INI:
  1. Menyambung ke server lewat SSH (SSH key kalau alias 'bric-prod' ada di
     ~/.ssh/config, kalau tidak fallback password interaktif — lihat
     deploy_common.py. Password TIDAK PERNAH disimpan/ditampilkan).
  2. Mengecek dulu file migration & runner-nya ADA di server:
       backend/src/migrations/create_warroom_mpng3.sql
       backend/scripts/run-warroom-mpng3-migration.js
     Kalau salah satu tidak ada -> BERHENTI, tidak menjalankan apa pun.
  3. Menjalankan HANYA migration MPNG3:
       node backend/scripts/run-warroom-mpng3-migration.js
     TIDAK menjalankan migration lain apa pun.
  4. Setelah selesai, memverifikasi tabel warroom_mpng3_outlet benar-benar
     ada di database (query read-only lewat psql, DATABASE_URL TIDAK
     PERNAH ditampilkan di layar/log).
  5. TIDAK insert data apa pun, TIDAK menjalankan sync apa pun.

Cara pakai:
  python scripts/run_mpng3_migration_remote.py
"""

import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deploy_common import get_deploy_config, connect_ssh, run_remote, mask  # noqa: E402

MIGRATION_SQL_REL = "backend/src/migrations/create_warroom_mpng3.sql"
MIGRATION_RUNNER_REL = "backend/scripts/run-warroom-mpng3-migration.js"
EXPECTED_TABLES = ["warroom_mpng3_outlet"]


def run_migration(config: dict) -> bool:
    remote_project = config["REMOTE_PROJECT_PATH"]

    print(f">>> Menyambung ke server {mask(config['VPS_HOST'])} ...")
    client = connect_ssh(config)

    try:
        print("\n>>> [1/4] Cek file migration & runner tersedia di server ...")
        check_cmd = (
            f"cd {remote_project} && "
            f"[ -f {MIGRATION_SQL_REL} ] && echo SQL_FOUND; "
            f"[ -f {MIGRATION_RUNNER_REL} ] && echo RUNNER_FOUND"
        )
        out, err, code = run_remote(client, check_cmd)
        if "SQL_FOUND" not in out or "RUNNER_FOUND" not in out:
            print(f"[STOP] File migration/runner tidak lengkap di server. Detail: {out.strip()} {err.strip()}")
            print("       Pastikan sudah git pull dulu (lewat safe_deploy.py atau manual).")
            return False
        print(f"[OK] {MIGRATION_SQL_REL} dan {MIGRATION_RUNNER_REL} ditemukan di server.")

        print(f"\n>>> [2/4] Menjalankan: node {MIGRATION_RUNNER_REL} ...")
        out, err, code = run_remote(client, f"cd {remote_project} && node {MIGRATION_RUNNER_REL} 2>&1", timeout=60)
        print(out.strip())
        if code != 0 or "Migration OK" not in out:
            print("[GAGAL] Migration tidak berhasil. Database TIDAK diubah lebih lanjut oleh script ini.")
            return False
        print("[OK] Migration runner melaporkan sukses.")

        print("\n>>> [3/4] Verifikasi tabel di database (read-only) ...")
        verify_cmd = (
            f"cd {remote_project} && "
            "set -a && source backend/.env && set +a && "
            'psql "$DATABASE_URL" -t -c "'
            "SELECT string_agg(tablename, ',') FROM pg_tables WHERE tablename = 'warroom_mpng3_outlet'"
            '"'
        )
        out, err, code = run_remote(client, verify_cmd, timeout=30)
        found_tables = [t.strip() for t in out.strip().split(",") if t.strip()]
        missing = [t for t in EXPECTED_TABLES if t not in found_tables]

        print(f"   Tabel ditemukan di database: {found_tables if found_tables else '(tidak ada)'}")
        if missing:
            print(f"[PERINGATAN] Tabel berikut BELUM ditemukan: {missing}")
            return False
        print("[OK] Tabel warroom_mpng3_outlet terkonfirmasi ada.")

        print("\n>>> [4/4] Migration MPNG3 selesai dengan sukses.")
        return True
    finally:
        client.close()


def main():
    print("==============================================================")
    print("  BRIC DASHBOARD — MIGRATION WAR-ROOM MPNG3 (production)")
    print("==============================================================")
    print("Script ini HANYA menjalankan migration MPNG3.")
    print("TIDAK menjalankan migration lain, TIDAK insert data, TIDAK sync.")
    print()

    confirm = input("Ketik 'MIGRATE' (huruf besar) untuk lanjut, apa saja selain itu untuk batal: ").strip()
    if confirm != "MIGRATE":
        print("Dibatalkan. Tidak ada perubahan yang dilakukan.")
        return

    config = get_deploy_config(interactive=True)
    success = run_migration(config)

    print()
    print("=== Migration MPNG3 SELESAI (sukses). ===" if success
          else "=== Migration MPNG3 GAGAL / BELUM LENGKAP — lihat pesan di atas. ===")


if __name__ == "__main__":
    main()
