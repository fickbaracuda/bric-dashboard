"""
scripts/backup_db.py

PART 2A — Script backup database PostgreSQL (BRIC Dashboard).

APA YANG DILAKUKAN SCRIPT INI (kalau dijalankan):
  1. Menyambung ke server (VPS) lewat SSH.
  2. Di server, mengecek dulu apakah DATABASE_URL sudah ada di file
     backend/.env milik server. Kalau tidak ada -> BERHENTI, tidak
     mencoba backup sama sekali.
  3. Kalau ada, menjalankan "pg_dump" (alat bawaan PostgreSQL untuk
     membuat cadangan) memakai DATABASE_URL tersebut.
  4. Cadangan disimpan di server, di folder backups/db/, dengan nama
     file yang mengandung tanggal & jam (contoh: bric_db_20260702_193000.sql)
  5. Kalau berhasil, file cadangan itu JUGA disalin (download) ke folder
     lokal backups/db/ di komputer ini — supaya ada 2 salinan (di server
     dan di komputer lokal), jaga-jaga kalau server bermasalah.

TIDAK PERNAH:
  - Menyimpan password DATABASE_URL di file ini.
  - Menampilkan isi DATABASE_URL di layar/log.
  - Menghapus atau mengubah data apa pun di database (hanya membaca untuk dump).

PENTING — SESUAI INSTRUKSI PART 2A:
  Script ini BOLEH dibuat, tapi TIDAK dijalankan ke production sekarang.
  Baru jalankan setelah pemilik project (Anda) memerintahkan secara eksplisit.

Cara pakai (nanti, kalau sudah siap):
  python scripts/backup_db.py
"""

import sys
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deploy_common import get_deploy_config, connect_ssh, run_remote, mask  # noqa: E402

LOCAL_BACKUP_DIR = Path(__file__).resolve().parent.parent / "backups" / "db"


def backup_database(config: dict) -> bool:
    """
    Jalankan backup database di server. Mengembalikan True kalau sukses.
    """
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    remote_project = config["REMOTE_PROJECT_PATH"]
    remote_backup_dir = f"{remote_project}/backups/db"
    remote_dump_file = f"{remote_backup_dir}/bric_db_{timestamp}.sql"

    print(f">>> Menyambung ke server {mask(config['VPS_HOST'])} ...")
    client = connect_ssh(config)

    try:
        # 1) Cek dulu apakah DATABASE_URL ada di backend/.env server — TANPA menampilkan isinya.
        print(">>> Mengecek apakah DATABASE_URL tersedia di server ...")
        check_cmd = (
            f"cd {remote_project} && "
            "if [ -f backend/.env ] && grep -q '^DATABASE_URL=' backend/.env; "
            "then echo FOUND; else echo MISSING; fi"
        )
        out, err, code = run_remote(client, check_cmd)
        if "FOUND" not in out:
            print("[STOP] DATABASE_URL tidak ditemukan di backend/.env pada server.")
            print("       Backup DIBATALKAN. Tidak ada perintah pg_dump yang dijalankan.")
            return False
        print("[OK] DATABASE_URL ditemukan di server (nilainya tidak ditampilkan).")

        # 2) Siapkan folder backup di server
        run_remote(client, f"mkdir -p {remote_backup_dir}")

        # 3) Jalankan pg_dump, membaca DATABASE_URL langsung dari backend/.env server
        #    (nilai DATABASE_URL tidak pernah lewat/tersimpan di komputer lokal).
        print(">>> Menjalankan pg_dump di server ...")
        dump_cmd = (
            f"cd {remote_project} && "
            "set -a && source backend/.env && set +a && "
            f'pg_dump "$DATABASE_URL" -f {remote_dump_file} 2>&1 && '
            f"echo DUMP_OK && ls -la {remote_dump_file}"
        )
        out, err, code = run_remote(client, dump_cmd, timeout=300)

        if code != 0 or "DUMP_OK" not in out:
            print("[GAGAL] pg_dump tidak berhasil. Detail (disamarkan kalau ada kredensial):")
            print("   ", out.strip()[-500:])
            if err.strip():
                print("   [stderr]", err.strip()[-500:])
            return False

        print(f"[OK] Backup database berhasil dibuat di server: {remote_dump_file}")

        # 4) Salin (download) hasil dump ke folder lokal, sebagai cadangan kedua
        LOCAL_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        local_path = LOCAL_BACKUP_DIR / f"bric_db_{timestamp}.sql"
        print(f">>> Menyalin cadangan ke komputer lokal: {local_path}")
        sftp = client.open_sftp()
        sftp.get(remote_dump_file, str(local_path))
        sftp.close()
        print(f"[OK] Cadangan lokal tersimpan di: {local_path}")

        return True
    finally:
        client.close()


def main():
    print("==============================================================")
    print("  BRIC DASHBOARD — BACKUP DATABASE (Part 2A)")
    print("==============================================================")
    print("Script ini akan membuat cadangan database di server, lalu")
    print("menyalinnya juga ke komputer lokal (folder backups/db/, tidak ikut Git).")
    print()

    confirm = input("Ketik 'BACKUP' (huruf besar) untuk lanjut, apa saja selain itu untuk batal: ").strip()
    if confirm != "BACKUP":
        print("Dibatalkan. Tidak ada perubahan/aksi yang dilakukan.")
        return

    config = get_deploy_config(interactive=True)
    success = backup_database(config)

    print()
    if success:
        print("=== Backup database SELESAI dengan sukses. ===")
    else:
        print("=== Backup database GAGAL / DIBATALKAN. Database production TIDAK diubah. ===")


if __name__ == "__main__":
    main()
