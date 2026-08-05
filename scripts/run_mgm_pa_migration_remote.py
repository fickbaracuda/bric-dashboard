"""
scripts/run_mgm_pa_migration_remote.py

Jalankan migration MGM PA Control Tower di server PRODUCTION dengan aman
lewat SSH — mengikuti pola persis run_payment_agent_produk_migration_remote.py.

APA YANG DILAKUKAN SCRIPT INI:
  1. Menyambung ke server lewat SSH (SSH key kalau alias 'bric-prod' ada di
     ~/.ssh/config, kalau tidak fallback password interaktif — lihat
     deploy_common.py. Password TIDAK PERNAH disimpan/ditampilkan).
  2. Preflight READ-ONLY (semua harus lulus sebelum prompt konfirmasi
     ditampilkan — kalau ada yang gagal, script BERHENTI tanpa bertanya):
       - file backup /home/admin/bric-dashboard/backups/db/bric_db_20260805_075343.sql
         ada dan ukurannya > 0 byte;
       - HEAD git production persis 88c4df7891abecf4113b8c2f73016f9070cdd1ec;
       - salah satu env MGM_SYNC_TOKEN atau MGM_PA_SYNC_TOKEN ada di
         backend/.env (HANYA status ADA/TIDAK ADA yang dicetak, NILAI-nya
         TIDAK PERNAH ditampilkan);
       - GET /health mengembalikan HTTP 200;
       - PostgreSQL bisa diakses (SELECT 1 lewat DATABASE_URL server,
         DATABASE_URL sendiri TIDAK PERNAH dicetak).
  3. Minta konfirmasi interaktif persis: "Ketik MIGRATE untuk melanjutkan: "
     Input selain 'MIGRATE' -> batal, TIDAK ADA perubahan apa pun.
  4. Setelah konfirmasi, jalankan HANYA:
       cd /home/admin/bric-dashboard && node backend/scripts/run-mgm-pa-migration.js
     TIDAK menjalankan migration QRIS, TIDAK reload PM2/nginx, TIDAK build
     frontend, TIDAK menjalankan Apps Script, TIDAK deploy.
  5. Setelah migration sukses, verifikasi READ-ONLY:
       - 6 tabel mgm_pa_* ada;
       - index mgm_pa_* dari migration ada;
       - tabel legacy mgm_registrasi & mgm_aktivasi masih ada;
       - row count kedua tabel legacy dicatat SEBELUM dan SESUDAH migration,
         harus identik (migration ini TIDAK BOLEH mengubah tabel legacy);
       - tabel mgm_pa_* harus 0 baris (belum ada sync Apps Script);
       - idempotency: migration runner dijalankan KEDUA KALINYA (CREATE
         TABLE/INDEX IF NOT EXISTS harus sukses lagi tanpa error, row count
         tetap 0/tidak berubah) sebagai BUKTI aman dijalankan ulang, bukan
         cuma diklaim dari membaca kode.
  6. Folder karantina (frontend/backend untracked file lama) TIDAK disentuh
     sama sekali oleh script ini.
  7. TIDAK PERNAH mencetak password, DATABASE_URL, atau isi token env.

Cara pakai:
  python scripts/run_mgm_pa_migration_remote.py
"""

import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deploy_common import get_deploy_config, connect_ssh, run_remote, mask  # noqa: E402

TARGET_COMMIT = "88c4df7891abecf4113b8c2f73016f9070cdd1ec"
BACKUP_PATH = "/home/admin/bric-dashboard/backups/db/bric_db_20260805_075343.sql"

MIGRATION_SQL_REL = "backend/src/migrations/create_mgm_pa_control_tower.sql"
MIGRATION_RUNNER_REL = "backend/scripts/run-mgm-pa-migration.js"

EXPECTED_TABLES = [
    "mgm_pa_registrasi",
    "mgm_pa_aktivasi",
    "mgm_pa_aktivasi_detail",
    "mgm_pa_sync_runs",
    "mgm_pa_actions",
    "mgm_pa_pb_targets",
]
EXPECTED_INDEXES = [
    "idx_mgm_pa_reg_periode_upline",
    "idx_mgm_pa_reg_periode_tanggal",
    "idx_mgm_pa_reg_outlet",
    "idx_mgm_pa_act_periode_upline",
    "idx_mgm_pa_act_periode_tanggal",
    "idx_mgm_pa_act_outlet",
    "idx_mgm_pa_detail_periode_upline",
    "idx_mgm_pa_detail_outlet",
    "idx_mgm_pa_detail_payment",
    "idx_mgm_pa_actions_queue",
]
LEGACY_TABLES = ["mgm_registrasi", "mgm_aktivasi"]


def psql(client, remote_project, sql, timeout=30):
    """Jalankan 1 statement SQL read-only lewat psql, DATABASE_URL tidak pernah dicetak."""
    cmd = (
        f"cd {remote_project} && set -a && source backend/.env && set +a && "
        f'psql "$DATABASE_URL" -t -A -c "{sql}"'
    )
    out, err, code = run_remote(client, cmd, timeout=timeout)
    return out.strip(), err.strip(), code


def legacy_row_counts(client, remote_project):
    counts = {}
    for t in LEGACY_TABLES:
        out, _, _ = psql(client, remote_project, f"SELECT COUNT(*) FROM {t}")
        counts[t] = out.strip()
    return counts


def mgm_pa_row_counts(client, remote_project):
    counts = {}
    for t in EXPECTED_TABLES:
        out, _, _ = psql(client, remote_project, f"SELECT COUNT(*) FROM {t}")
        counts[t] = out.strip()
    return counts


def preflight(client, remote_project):
    """Semua check read-only. Return True kalau semua lulus."""
    ok = True

    print(">>> [Preflight 1/5] Backup database ...")
    out, _, _ = run_remote(client, f"[ -f {BACKUP_PATH} ] && stat -c '%s' {BACKUP_PATH} || echo MISSING")
    size = out.strip()
    if size == "MISSING" or not size.isdigit() or int(size) <= 0:
        print(f"    [GAGAL] Backup tidak ditemukan atau ukuran 0: {BACKUP_PATH}")
        ok = False
    else:
        print(f"    [OK] Backup ada, ukuran {int(size):,} bytes -> {BACKUP_PATH}")

    print("\n>>> [Preflight 2/5] HEAD git production ...")
    out, _, _ = run_remote(client, f"cd {remote_project} && git rev-parse HEAD")
    head = out.strip()
    if head != TARGET_COMMIT:
        print(f"    [GAGAL] HEAD production = {head}, diharapkan {TARGET_COMMIT}")
        ok = False
    else:
        print(f"    [OK] HEAD production = {head}")

    print("\n>>> [Preflight 3/5] Token MGM (status saja, nilai TIDAK ditampilkan) ...")
    env_path = f"{remote_project}/backend/.env"
    any_token = False
    for key in ["MGM_SYNC_TOKEN", "MGM_PA_SYNC_TOKEN"]:
        out, _, _ = run_remote(client, f"grep -qE '^{key}=.+' {env_path} && echo ADA || echo TIDAK_ADA")
        status = out.strip()
        print(f"    {key} -> {status.replace('_', ' ')}")
        if status == "ADA":
            any_token = True
    if not any_token:
        print("    [GAGAL] MGM_SYNC_TOKEN dan MGM_PA_SYNC_TOKEN dua-duanya tidak ada.")
        ok = False
    else:
        print("    [OK] Minimal satu token tersedia.")

    print("\n>>> [Preflight 4/5] GET /health ...")
    out, _, _ = run_remote(client, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/health")
    code_str = out.strip()
    if code_str != "200":
        print(f"    [GAGAL] /health HTTP {code_str}")
        ok = False
    else:
        print("    [OK] /health HTTP 200")

    print("\n>>> [Preflight 5/5] PostgreSQL dapat diakses ...")
    out, err, code = psql(client, remote_project, "SELECT 1")
    if out.strip() != "1":
        print(f"    [GAGAL] Tidak bisa SELECT 1. stderr: {err[-300:]}")
        ok = False
    else:
        print("    [OK] PostgreSQL reachable.")

    return ok


def run_migration_once(client, remote_project, label):
    print(f"\n>>> Menjalankan migration runner ({label}): node {MIGRATION_RUNNER_REL} ...")
    out, err, code = run_remote(client, f"cd {remote_project} && node {MIGRATION_RUNNER_REL} 2>&1", timeout=60)
    print(out.strip())
    success = code == 0 and "Migration OK" in out
    if not success:
        print(f"[GAGAL] Migration runner ({label}) tidak melaporkan sukses.")
    return success


def main():
    print("==============================================================")
    print("  BRIC DASHBOARD — MIGRATION MGM PA CONTROL TOWER (production)")
    print("==============================================================")
    print("Script ini HANYA menjalankan migration MGM PA (6 tabel mgm_pa_*).")
    print("TIDAK menjalankan migration QRIS, TIDAK reload PM2/nginx,")
    print("TIDAK build frontend, TIDAK menjalankan Apps Script, TIDAK deploy.")
    print()

    config = get_deploy_config(interactive=True)
    print(f">>> Menyambung ke server {mask(config['VPS_HOST'])} ...")
    client = connect_ssh(config)

    try:
        remote_project = config["REMOTE_PROJECT_PATH"]

        print("=== PREFLIGHT (read-only) ===\n")
        if not preflight(client, remote_project):
            print("\n[STOP] Salah satu preflight gagal. Migration DIBATALKAN. Tidak ada perubahan.")
            return
        print("\n=== Semua preflight LULUS. ===\n")

        # Snapshot row count tabel legacy SEBELUM migration.
        print(">>> Mencatat row count tabel legacy SEBELUM migration ...")
        legacy_before = legacy_row_counts(client, remote_project)
        for t, c in legacy_before.items():
            print(f"    {t}: {c} baris")

        confirm = input("\nKetik MIGRATE untuk melanjutkan: ").strip()
        if confirm != "MIGRATE":
            print("Dibatalkan. Tidak ada perubahan yang dilakukan.")
            return

        # Jalankan migration pertama kali.
        if not run_migration_once(client, remote_project, "run pertama"):
            print("\n[STOP] Migration gagal. Database TIDAK diubah lebih lanjut oleh script ini.")
            return

        print("\n=== VERIFIKASI (read-only) ===\n")

        print(">>> Verifikasi 6 tabel mgm_pa_* ...")
        out, _, _ = psql(client, remote_project,
                          "SELECT string_agg(table_name, ',') FROM information_schema.tables "
                          "WHERE table_schema='public' AND table_name LIKE 'mgm_pa_%'")
        found_tables = [t.strip() for t in out.split(",") if t.strip()]
        missing_tables = [t for t in EXPECTED_TABLES if t not in found_tables]
        print(f"    Ditemukan: {found_tables}")
        if missing_tables:
            print(f"    [PERINGATAN] Tabel belum ada: {missing_tables}")
        else:
            print("    [OK] Semua 6 tabel mgm_pa_* ada.")

        print("\n>>> Verifikasi index mgm_pa_* ...")
        out, _, _ = psql(client, remote_project,
                          "SELECT string_agg(indexname, ',') FROM pg_indexes "
                          "WHERE schemaname='public' AND indexname LIKE 'idx_mgm_pa_%'")
        found_idx = [i.strip() for i in out.split(",") if i.strip()]
        missing_idx = [i for i in EXPECTED_INDEXES if i not in found_idx]
        print(f"    Ditemukan: {found_idx}")
        if missing_idx:
            print(f"    [PERINGATAN] Index belum ada: {missing_idx}")
        else:
            print("    [OK] Semua 10 index mgm_pa_* ada.")

        print("\n>>> Verifikasi tabel legacy masih ada ...")
        out, _, _ = psql(client, remote_project,
                          "SELECT string_agg(table_name, ',') FROM information_schema.tables "
                          "WHERE table_schema='public' AND table_name IN ('mgm_registrasi','mgm_aktivasi')")
        found_legacy = [t.strip() for t in out.split(",") if t.strip()]
        for t in LEGACY_TABLES:
            print(f"    {t}: {'ADA' if t in found_legacy else '[HILANG!!]'}")

        print("\n>>> Row count tabel legacy SESUDAH migration (harus identik dgn sebelum) ...")
        legacy_after = legacy_row_counts(client, remote_project)
        legacy_unchanged = True
        for t in LEGACY_TABLES:
            before, after = legacy_before.get(t), legacy_after.get(t)
            same = before == after
            legacy_unchanged = legacy_unchanged and same
            print(f"    {t}: sebelum={before}  sesudah={after}  -> {'SAMA' if same else '[BERUBAH!!]'}")

        print("\n>>> Row count tabel mgm_pa_* (harus 0, belum ada sync Apps Script) ...")
        mgm_counts_1 = mgm_pa_row_counts(client, remote_project)
        all_empty = True
        for t, c in mgm_counts_1.items():
            empty = c == "0"
            all_empty = all_empty and empty
            print(f"    {t}: {c} baris {'[OK]' if empty else '[TIDAK KOSONG!!]'}")

        print("\n=== IDEMPOTENCY CHECK — jalankan migration KEDUA KALINYA ===")
        idempotent = run_migration_once(client, remote_project, "run kedua, idempotency check")
        print("\n>>> Row count mgm_pa_* setelah run kedua (harus tetap sama) ...")
        mgm_counts_2 = mgm_pa_row_counts(client, remote_project)
        idempotent_counts_match = mgm_counts_1 == mgm_counts_2
        for t in EXPECTED_TABLES:
            print(f"    {t}: run1={mgm_counts_1.get(t)}  run2={mgm_counts_2.get(t)}")
        print(f"    -> {'KONSISTEN' if idempotent_counts_match else '[BERUBAH!!]'}")

        print("\n>>> Row count tabel legacy setelah run kedua (harus tetap identik) ...")
        legacy_after2 = legacy_row_counts(client, remote_project)
        legacy_still_unchanged = legacy_after2 == legacy_before
        for t in LEGACY_TABLES:
            print(f"    {t}: awal={legacy_before.get(t)}  setelah_run2={legacy_after2.get(t)}")

        print("\n==============================================================")
        print("  RINGKASAN")
        print("==============================================================")
        print(f"Migration run 1       : {'SUKSES' if True else 'GAGAL'}")
        print(f"Migration run 2 (idempotency): {'SUKSES' if idempotent else 'GAGAL'}")
        print(f"6 tabel mgm_pa_*       : {'LENGKAP' if not missing_tables else f'KURANG: {missing_tables}'}")
        print(f"10 index mgm_pa_*      : {'LENGKAP' if not missing_idx else f'KURANG: {missing_idx}'}")
        print(f"Tabel legacy tetap ada : {'YA' if len(found_legacy) == 2 else 'TIDAK — PERIKSA SEGERA'}")
        print(f"Row count legacy tetap : {'YA' if legacy_unchanged and legacy_still_unchanged else 'BERUBAH — PERIKSA SEGERA'}")
        print(f"Tabel mgm_pa_* kosong  : {'YA' if all_empty else 'TIDAK — ADA DATA TAK TERDUGA'}")
        print(f"Idempotency (run ulang aman): {'TERBUKTI' if idempotent and idempotent_counts_match else 'GAGAL DIBUKTIKAN'}")
        print()
        print("TIDAK ADA deploy, PM2 reload, nginx reload, atau Apps Script sync")
        print("yang dijalankan oleh script ini.")
    finally:
        client.close()


if __name__ == "__main__":
    main()
