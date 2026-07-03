"""
scripts/validate_dm_control_tower_sync.py

Tahap final DM Control Tower — validasi HASIL SYNC secara read-only.

APA YANG DILAKUKAN SCRIPT INI (semua HANYA membaca, tidak ada 1 pun
perintah yang mengubah data):
  1. Jumlah baris per tabel (dm_ct_raw_register/aktivasi/trx) untuk 1 bulan.
  2. Isi dm_ct_month_config untuk bulan itu (period_start/end/mature_cohort_end).
  3. Ringkasan dm_ct_sync_log untuk bulan itu (per source_type: total
     received/inserted/skipped, jumlah chunk, status, sync terakhir).
  4. Baris dm_ct_sync_log berstatus 'error' (kalau ada) beserta pesannya.
  5. Perkiraan 1 angka data quality (transaksi sebelum aktivasi) untuk
     dibandingkan dengan ekspektasi dari Excel/Google Sheet.

TIDAK PERNAH menampilkan DATABASE_URL atau credential apa pun.
TIDAK PERNAH mengubah/menghapus data.

Cara pakai:
  python scripts/validate_dm_control_tower_sync.py [bulan]
  (default bulan = 2026-06 kalau tidak diisi)
"""

import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deploy_common import get_deploy_config, connect_ssh, run_remote, mask  # noqa: E402

BULAN = sys.argv[1] if len(sys.argv) > 1 else "2026-06"


def psql(client, remote_project, sql, tuples_only=True):
    flag = "-t -A -F'|'" if tuples_only else ""
    cmd = (
        f"cd {remote_project} && set -a && source backend/.env && set +a && "
        f'psql "$DATABASE_URL" {flag} -c "{sql}"'
    )
    out, err, code = run_remote(client, cmd, timeout=30)
    return out.strip(), err.strip(), code


def main():
    print("==============================================================")
    print(f"  BRIC DASHBOARD — VALIDASI SYNC DM CONTROL TOWER (bulan={BULAN})")
    print("==============================================================")
    print("Semua query di bawah READ-ONLY. Tidak ada data yang diubah.")
    print()

    config = get_deploy_config(interactive=True)
    remote_project = config["REMOTE_PROJECT_PATH"]

    print(f">>> Menyambung ke server {mask(config['VPS_HOST'])} ...")
    client = connect_ssh(config)

    try:
        print(f"\n1) Jumlah baris per tabel untuk bulan={BULAN}:")
        for tbl in ["dm_ct_raw_register", "dm_ct_raw_aktivasi", "dm_ct_raw_trx"]:
            out, err, code = psql(client, remote_project, f"SELECT COUNT(*) FROM {tbl} WHERE bulan='{BULAN}'")
            print(f"   {tbl:22s} -> {out or '(gagal baca: ' + err[:120] + ')'}")

        print(f"\n2) Isi dm_ct_month_config untuk bulan={BULAN}:")
        out, err, code = psql(
            client, remote_project,
            f"SELECT bulan, period_start, period_end, mature_cohort_end, updated_at "
            f"FROM dm_ct_month_config WHERE bulan='{BULAN}'",
        )
        if out:
            parts = out.split("|")
            labels = ["bulan", "period_start", "period_end", "mature_cohort_end", "updated_at"]
            for label, val in zip(labels, parts):
                print(f"   {label:18s} -> {val}")
        else:
            print(f"   [PERHATIAN] Tidak ada baris config untuk bulan {BULAN} (analytics akan pakai fallback kalender).")

        print(f"\n3) Ringkasan dm_ct_sync_log untuk bulan={BULAN} (per source, digabung semua chunk):")
        out, err, code = psql(
            client, remote_project,
            f"SELECT source_type, status, SUM(rows_received), SUM(rows_inserted), SUM(rows_skipped), "
            f"COUNT(*), MAX(synced_at) FROM dm_ct_sync_log WHERE bulan='{BULAN}' "
            f"GROUP BY source_type, status ORDER BY source_type, status",
        )
        if out:
            print("   source_type | status | total_received | total_inserted | total_skipped | jumlah_chunk | sync_terakhir")
            for line in out.splitlines():
                print(f"   {line}")
        else:
            print(f"   [PERHATIAN] Tidak ada riwayat sync_log untuk bulan {BULAN} sama sekali.")

        print(f"\n4) Baris sync_log berstatus 'error' untuk bulan={BULAN} (10 terbaru):")
        out, err, code = psql(
            client, remote_project,
            f"SELECT source_type, synced_at, error_message FROM dm_ct_sync_log "
            f"WHERE bulan='{BULAN}' AND status='error' ORDER BY synced_at DESC LIMIT 10",
        )
        print("   " + (out.replace("\n", "\n   ") if out else "(tidak ada error — bagus)"))

        print(f"\n5) Perkiraan data quality — transaksi sebelum aktivasi (bulan={BULAN}):")
        dq_sql = (
            f"WITH akt AS (SELECT id_outlet, tanggal_aktivasi FROM dm_ct_raw_aktivasi WHERE bulan='{BULAN}'), "
            f"trx_agg AS (SELECT id_outlet, MIN(tanggal_transaksi) AS first_tx FROM dm_ct_raw_trx "
            f"WHERE bulan='{BULAN}' GROUP BY id_outlet) "
            f"SELECT COUNT(*) FROM akt JOIN trx_agg USING (id_outlet) "
            f"WHERE trx_agg.first_tx IS NOT NULL AND trx_agg.first_tx < akt.tanggal_aktivasi"
        )
        out, err, code = psql(client, remote_project, dq_sql)
        print(f"   trx_before_aktivasi -> {out or '(gagal: ' + err[:120] + ')'}")

        print("\n=== Validasi selesai. Tidak ada data yang diubah. ===")

    finally:
        client.close()


if __name__ == "__main__":
    main()
