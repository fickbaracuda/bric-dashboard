"""
scripts/run_farming_command_center_migration_remote.py

Jalankan migration Farming Command Center di server PRODUCTION dengan aman
lewat SSH — mengikuti pola persis run_payment_agent_produk_migration_remote.py
dan run_dm_control_tower_migration_remote.py.

APA YANG DILAKUKAN SCRIPT INI:
  1. Menyambung ke server lewat SSH (SSH key alias 'bric-prod' kalau ada,
     fallback password interaktif — lihat deploy_common.py).
  2. Mengecek dulu file migration & runner-nya ADA di server:
       backend/src/migrations/create_farming_command_center.sql
       backend/scripts/run-farming-command-center-migration.js
     Kalau salah satu tidak ada -> BERHENTI, tidak menjalankan apa pun.
  3. Menjalankan HANYA migration Farming Command Center:
       node backend/scripts/run-farming-command-center-migration.js
     TIDAK menjalankan migration lain apa pun. TABEL LAMA farming_snapshot
     TIDAK disentuh sama sekali oleh migration ini.
  4. Setelah selesai, memverifikasi 3 tabel berikut benar-benar ada di
     database (query read-only lewat psql, DATABASE_URL TIDAK PERNAH
     ditampilkan di layar/log):
       farming_outlet_snapshot, farming_sync_log, farming_outlet_followup
  5. TIDAK insert data apa pun, TIDAK menjalankan sync apa pun.

Cara pakai:
  python scripts/run_farming_command_center_migration_remote.py
"""

import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deploy_common import get_deploy_config, connect_ssh, run_remote, mask  # noqa: E402

MIGRATION_SQL_REL = "backend/src/migrations/create_farming_command_center.sql"
MIGRATION_RUNNER_REL = "backend/scripts/run-farming-command-center-migration.js"
EXPECTED_TABLES = [
    "farming_outlet_snapshot",
    "farming_sync_log",
    "farming_outlet_followup",
]


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
            "SELECT string_agg(tablename, ',') FROM pg_tables WHERE tablename LIKE 'farming_%'"
            '"'
        )
        out, err, code = run_remote(client, verify_cmd, timeout=30)
        found_tables = [t.strip() for t in out.strip().split(",") if t.strip()]
        missing = [t for t in EXPECTED_TABLES if t not in found_tables]

        print(f"   Tabel farming_* ditemukan di database: {found_tables if found_tables else '(tidak ada)'}")
        if missing:
            print(f"[PERINGATAN] Tabel berikut BELUM ditemukan: {missing}")
            return False
        print("[OK] Semua 3 tabel baru Farming Command Center terkonfirmasi ada.")
        print("[INFO] Tabel lama farming_snapshot TIDAK disentuh oleh migration ini (harus tetap ada, dicek terpisah kalau perlu).")

        print("\n>>> [4/4] Migration Farming Command Center selesai dengan sukses.")
        return True
    finally:
        client.close()


def main():
    print("==============================================================")
    print("  BRIC DASHBOARD — MIGRATION FARMING COMMAND CENTER (production)")
    print("==============================================================")
    print("Script ini HANYA menjalankan migration Farming Command Center.")
    print("TIDAK menjalankan migration lain, TIDAK insert data, TIDAK sync.")
    print("Tabel lama farming_snapshot TIDAK disentuh sama sekali.")
    print()

    confirm = input("Ketik 'MIGRATE' (huruf besar) untuk lanjut, apa saja selain itu untuk batal: ").strip()
    if confirm != "MIGRATE":
        print("Dibatalkan. Tidak ada perubahan yang dilakukan.")
        return

    config = get_deploy_config(interactive=True)
    success = run_migration(config)

    print()
    print("=== Migration Farming Command Center SELESAI (sukses). ===" if success
          else "=== Migration Farming Command Center GAGAL / BELUM LENGKAP — lihat pesan di atas. ===")


if __name__ == "__main__":
    main()
