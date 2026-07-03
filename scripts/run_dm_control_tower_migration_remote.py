"""
scripts/run_dm_control_tower_migration_remote.py

Tahap approval pertama DM Control Tower — jalankan migration DM Control
Tower di server PRODUCTION dengan aman lewat SSH.

APA YANG DILAKUKAN SCRIPT INI:
  1. Menyambung ke server lewat SSH (password diketik interaktif, TIDAK
     pernah disimpan/ditampilkan — sama seperti backup_db.py/safe_deploy.py).
  2. Mengecek dulu file migration & runner-nya ADA di server:
       backend/src/migrations/create_dm_control_tower.sql
       backend/scripts/run-dm-control-tower-migration.js
     Kalau salah satu tidak ada -> BERHENTI, tidak menjalankan apa pun.
  3. Menjalankan HANYA migration DM Control Tower:
       node backend/scripts/run-dm-control-tower-migration.js
     TIDAK menjalankan migration lain apa pun.
  4. Setelah selesai, memverifikasi 5 tabel berikut benar-benar ada di
     database (query read-only lewat psql, DATABASE_URL TIDAK PERNAH
     ditampilkan di layar/log):
       dm_ct_raw_register, dm_ct_raw_aktivasi, dm_ct_raw_trx,
       dm_ct_sync_log, dm_ct_month_config
  5. TIDAK insert data apa pun, TIDAK menjalankan sync apa pun.

Cara pakai:
  python scripts/run_dm_control_tower_migration_remote.py
"""

import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deploy_common import get_deploy_config, connect_ssh, run_remote, mask  # noqa: E402

MIGRATION_SQL_REL = "backend/src/migrations/create_dm_control_tower.sql"
MIGRATION_RUNNER_REL = "backend/scripts/run-dm-control-tower-migration.js"
EXPECTED_TABLES = [
    "dm_ct_raw_register",
    "dm_ct_raw_aktivasi",
    "dm_ct_raw_trx",
    "dm_ct_sync_log",
    "dm_ct_month_config",
]


def run_migration(config: dict) -> bool:
    remote_project = config["REMOTE_PROJECT_PATH"]

    print(f">>> Menyambung ke server {mask(config['VPS_HOST'])} ...")
    client = connect_ssh(config)

    try:
        # 1) Pastikan file migration & runner ada di server
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

        # 2) Jalankan HANYA migration DM Control Tower
        print(f"\n>>> [2/4] Menjalankan: node {MIGRATION_RUNNER_REL} ...")
        out, err, code = run_remote(client, f"cd {remote_project} && node {MIGRATION_RUNNER_REL} 2>&1", timeout=60)
        print(out.strip())
        if code != 0 or "Migration OK" not in out:
            print("[GAGAL] Migration tidak berhasil. Database TIDAK diubah lebih lanjut oleh script ini.")
            return False
        print("[OK] Migration runner melaporkan sukses.")

        # 3) Verifikasi 5 tabel benar-benar ada (read-only, DATABASE_URL tidak ditampilkan)
        print("\n>>> [3/4] Verifikasi tabel di database (read-only) ...")
        verify_cmd = (
            f"cd {remote_project} && "
            "set -a && source backend/.env && set +a && "
            'psql "$DATABASE_URL" -t -c "'
            "SELECT string_agg(tablename, ',') FROM pg_tables WHERE tablename LIKE 'dm_ct_%'"
            '"'
        )
        out, err, code = run_remote(client, verify_cmd, timeout=30)
        found_tables = [t.strip() for t in out.strip().split(",") if t.strip()]
        missing = [t for t in EXPECTED_TABLES if t not in found_tables]

        print(f"   Tabel dm_ct_* ditemukan di database: {found_tables if found_tables else '(tidak ada)'}")
        if missing:
            print(f"[PERINGATAN] Tabel berikut BELUM ditemukan: {missing}")
            return False
        print("[OK] Semua 5 tabel DM Control Tower terkonfirmasi ada.")

        # 4) Ringkasan
        print("\n>>> [4/4] Migration DM Control Tower selesai dengan sukses.")
        return True
    finally:
        client.close()


def main():
    print("==============================================================")
    print("  BRIC DASHBOARD — MIGRATION DM CONTROL TOWER (production)")
    print("==============================================================")
    print("Script ini HANYA menjalankan migration DM Control Tower.")
    print("TIDAK menjalankan migration lain, TIDAK insert data, TIDAK sync.")
    print()

    confirm = input("Ketik 'MIGRATE' (huruf besar) untuk lanjut, apa saja selain itu untuk batal: ").strip()
    if confirm != "MIGRATE":
        print("Dibatalkan. Tidak ada perubahan yang dilakukan.")
        return

    config = get_deploy_config(interactive=True)
    success = run_migration(config)

    print()
    print("=== Migration DM Control Tower SELESAI (sukses). ===" if success
          else "=== Migration DM Control Tower GAGAL / BELUM LENGKAP — lihat pesan di atas. ===")


if __name__ == "__main__":
    main()
