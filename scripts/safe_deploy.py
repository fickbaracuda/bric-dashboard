"""
scripts/safe_deploy.py

BRIC DASHBOARD — SAFE DEPLOY (Part 2A, HARDENED 2026-08 utk cegah CPU
saturation/downtime saat deploy — lihat docs/DEPLOYMENT_SAFETY.md bagian
"Deploy Hardening" utk detail lengkap & alasan tiap threshold).

MODE DEFAULT = DRY-RUN (rencana saja):
  python scripts/safe_deploy.py
  python scripts/safe_deploy.py --dry-run
  -> HANYA menampilkan langkah yang AKAN dilakukan. TIDAK menyambung ke server.

MODE EXECUTE:
  python scripts/safe_deploy.py --execute
  -> Minta ketik "DEPLOY" sbg konfirmasi terakhir (TIDAK BISA dilewati lewat
     pipe/stdin/expect/flag apa pun — lihat .claude/hooks/guard.py &
     .claude/rules/production-safety.md, ini kontrol keras yang SENGAJA
     tidak bisa diotomatisasi, termasuk oleh AI).
  -> Kalau git pull menarik commit BARU, BERHENTI dulu minta verifikasi
     manual, kecuali dijalankan ulang dgn --confirm-new-commit.

MODE PREBUILT FRONTEND (opsional, spec bagian G/12/13):
  python scripts/safe_deploy.py --execute --prebuilt-frontend <path-tarball.tar.gz> --prebuilt-checksum <sha256>
  -> Build TIDAK dilakukan di VPS sama sekali. Tarball hasil build LOKAL
     diupload, checksum diverifikasi SEBELUM dipakai, lalu di-extract ke
     release baru & di-switch atomic sama seperti mode build-di-VPS.
     CATATAN: build lokal di komputer Windows developer saat ini TIDAK bisa
     dijalankan langsung dari repo ini (Node.js tidak ada di PATH lokal —
     lihat CLAUDE.md) — mode ini disiapkan utk dipakai dari komputer/CI yang
     punya Node, bukan default saat ini.

PERUBAHAN UTAMA DARI VERSI SEBELUMNYA (audit CPU-saturation 2026-08-05):
  1. Resource preflight gate SEBELUM build (CPU/RAM/swap/disk/PM2/health/
     PG long-query) — deploy DITUNDA (bukan diteruskan) kalau server sedang
     tidak aman. Threshold di deploy_resource_guard.py, didokumentasikan.
  2. Change-aware: file yang berubah antara HEAD lama & baru diklasifikasi
     (deploy_change_classifier.py) — build frontend HANYA kalau frontend/
     berubah, PM2 reload HANYA kalau backend/ berubah.
  3. Build (kalau memang perlu) dijalankan low-priority (ionice+nice),
     dipantau via polling terpisah (BUKAN satu exec_command panjang —
     memperbaiki bug nyata: paramiko exec_command timeout TIDAK membunuh
     proses remote, cuma berhenti membaca lokal, jadi build macet bisa
     terus jalan di server SELAMANYA tanpa perbaikan ini). Kalau resource
     kritis berkepanjangan, HANYA process group build yang dihentikan —
     TIDAK PERNAH pkill/killall node, TIDAK PERNAH menyentuh PM2.
  4. Frontend release ATOMIC (releases/ + symlink, deploy_release_manager.py)
     menggantikan `cp -r dist/* /var/www/bric/` lama yang bisa membuat nginx
     menyajikan CAMPURAN file lama+baru selama proses copy. Rollback instan
     (re-point symlink), rilis lama otomatis di-prune (retensi 5) supaya
     disk tidak membengkak (disk produksi sudah 74% terpakai saat audit).
  5. Deploy lock (deploy_lock.py) — cegah dua `--execute` berjalan bersamaan
     ke server yang sama (mis. dari 2 komputer developer sekaligus).
  6. Post-deploy resource check + observability (setiap tahap dicatat
     dgn timing & snapshot resource sebelum/sesudah, TIDAK PERNAH secret).

URUTAN LANGKAH (tetap tidak boleh dilompati):
  0. Lock + kondisi awal (restart count PM2, HEAD, health) -> STOP kalau server sudah tidak aman
  1. Cek status Git di server (file dikenal -> lanjut; tak dikenal -> STOP) + git pull
     -> STOP kalau commit BARU tertarik (kecuali --confirm-new-commit)
  2. Preflight check aplikasi (--production) -> STOP kalau FAIL
  3. Klasifikasi perubahan (frontend/backend/docs-only) dari diff HEAD lama->baru
  4. Resource gate SEBELUM build (skip seluruhnya kalau frontend tidak berubah)
  5. Build low-priority + monitor (skip kalau frontend tidak berubah) -> STOP kalau gagal/di-abort
  6. Verifikasi isi release baru -> STOP kalau tidak lengkap
  7. Switch rilis ATOMIC (skip kalau tidak ada build baru)
  8. Reload backend via PM2 HANYA kalau backend berubah
  9. Health check -> rollback frontend otomatis kalau gagal DAN barusan switch rilis
  10. Post-deploy resource check + verifikasi akhir (restart count, dll)
  11. Prune rilis lama, lepas lock
"""

import re
import sys
import time
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deploy_common import get_deploy_config, connect_ssh, run_remote, mask  # noqa: E402
from deploy_resource_guard import (  # noqa: E402
    DEFAULT_THRESHOLDS, BUILD_MONITOR_DEFAULTS,
    fetch_resource_snapshot, evaluate_resource_gate, format_snapshot_report,
)
from deploy_change_classifier import classify_changed_paths  # noqa: E402
from deploy_lock import acquire_lock, release_lock  # noqa: E402
from deploy_release_manager import (  # noqa: E402
    new_release_dir, verify_release_contents, bootstrap_or_switch, rollback_to,
    prune_old_releases, compute_remote_sha256, compute_local_sha256,
)
from deploy_build_monitor import run_build_with_monitor  # noqa: E402

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
    # Dikonfirmasi pemilik project (2026-07-30): hasil npm install manual
    # di server sebelumnya, wajar, bukan perubahan kode fitur.
    "backend/package-lock.json",
    "frontend/package-lock.json",
    # Backup file dari hotfix darurat 2026-07-31 (outage 502, lihat commit
    # 56b8257) — file cadangan app.js sebelum 4 baris route Ekspedisi
    # outlet-status/notes di-nonaktifkan sementara. Aman diabaikan git status.
    "backend/src/app.js.backup-emergency-20260731-181447",
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
        rest = line[3:] if len(line) > 3 else line.strip()
        if " -> " in rest:
            rest = rest.split(" -> ", 1)[1]
        paths.append(rest.strip().strip('"'))
    return paths


def get_pm2_restart_count(client) -> "int | None":
    out, _, code = run_remote(client, "sudo -u admin pm2 jlist 2>/dev/null")
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
    "0. Ambil deploy lock + catat kondisi awal (restart count PM2, HEAD, health, resource) -> STOP kalau server sudah tidak sehat/aman",
    "1. Cek status Git di server (file safety dikenal -> lanjut; tak dikenal -> STOP) + git pull",
    "   -> STOP juga kalau git pull menarik commit BARU (kecuali --confirm-new-commit)",
    "2. Preflight check aplikasi (--production) -> STOP kalau FAIL",
    "3. Klasifikasi perubahan (frontend/backend/docs-only) dari diff HEAD lama->baru",
    "4. Resource gate SEBELUM build -> STOP/tunda kalau server tidak aman (DILEWATI kalau frontend tidak berubah)",
    "5. Build frontend low-priority + monitor (DILEWATI kalau frontend tidak berubah) -> STOP kalau gagal/di-abort",
    "6. Verifikasi isi release baru (index.html + file lengkap) -> STOP kalau tidak lengkap",
    "7. Switch rilis frontend ATOMIC (symlink re-point, DILEWATI kalau tidak ada build baru)",
    f"8. Reload backend via PM2 HANYA kalau backend berubah: {PM2_RELOAD_COMMAND}",
    f"9. Cek kesehatan backend: {HEALTH_CHECK_URL} -> rollback otomatis kalau gagal & barusan switch rilis",
    "10. Post-deploy resource check + verifikasi akhir (restart count PM2 wajar)",
    "11. Prune rilis frontend lama (retensi 5) + lepas deploy lock",
]


def print_plan():
    print("==============================================================")
    print("  BRIC DASHBOARD — SAFE DEPLOY (Hardened)")
    print("==============================================================")
    print("Rencana langkah yang akan dijalankan (urutan tetap, tidak boleh dilompati):")
    for step in STEPS_PLAN:
        print(f"   {step}")
    print()
    print("Aturan keras yang dipatuhi script ini:")
    print("   - TIDAK PERNAH memakai 'pkill'/'killall node'")
    print("   - TIDAK PERNAH menjalankan backend manual sebagai root (nohup dkk)")
    print("   - Restart backend HANYA lewat perintah PM2 resmi di atas, sebagai user 'admin'")
    print("   - Build frontend HANYA kalau frontend/ benar-benar berubah, low-priority, dipantau, aman dihentikan")
    print("   - PM2 reload HANYA kalau backend/ benar-benar berubah")
    print("   - Kalau build gagal, TIDAK lanjut menyalin/deploy apa pun")
    print("   - Rilis frontend ATOMIC (symlink), rilis lama tersimpan utk rollback instan")
    print("   - Deploy ditunda (bukan dipaksa lanjut) kalau resource server sedang tidak aman")
    print()


def log_stage(label: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"\n>>> [{ts}] {label}")


def run_deploy(config: dict, confirm_new_commit: bool = False, prebuilt_frontend: str = None, prebuilt_checksum: str = None):
    remote_project = config["REMOTE_PROJECT_PATH"]
    remote_frontend = config["REMOTE_FRONTEND_PATH"]
    stage_timings = {}

    def timed_stage(label, fn):
        log_stage(label)
        t0 = time.monotonic()
        result = fn()
        stage_timings[label] = round(time.monotonic() - t0, 1)
        return result

    print(f">>> Menyambung ke server {mask(config['VPS_HOST'])} ...")
    client = connect_ssh(config)
    lock_acquired = False
    switched_release = False
    previous_release_for_rollback = None

    try:
        # 0) Lock + kondisi awal
        log_stage("[0/11] Ambil deploy lock ...")
        lock_acquired, lock_msg = acquire_lock(run_remote, client, remote_project)
        print(f"   {lock_msg}")
        if not lock_acquired:
            print("[STOP] Tidak bisa mengambil deploy lock. Deploy DIBATALKAN.")
            return False

        log_stage("[0/11] Catat kondisi awal (resource, PM2 restart count, HEAD, health) ...")
        restart_before = get_pm2_restart_count(client)
        print(f"   Jumlah restart PM2 SEBELUM deploy: {restart_before if restart_before is not None else 'tidak bisa dibaca'}")
        out, _, _ = run_remote(client, f"cd {remote_project} && git rev-parse HEAD")
        head_before = out.strip()
        print(f"   Commit HEAD server SEBELUM pull: {head_before[:12]}...")

        snapshot_before = fetch_resource_snapshot(run_remote, client, remote_project)
        print(f"   Snapshot resource awal:\n{format_snapshot_report(snapshot_before)}")

        if snapshot_before.get("backend_healthy") is False:
            print("[STOP] Backend TIDAK sehat SEBELUM deploy dimulai. Deploy DIBATALKAN.")
            print("       Ini bukan disebabkan oleh script ini — server memang sudah bermasalah duluan.")
            return False

        ok, reasons = evaluate_resource_gate(snapshot_before, DEFAULT_THRESHOLDS)
        if not ok:
            print("\n[STOP] Deploy ditunda karena resource server sedang tinggi.")
            for r in reasons:
                print(f"       - {r}")
            print("       Coba lagi setelah beban server turun. Production TIDAK diubah apa pun.")
            return False
        print("   [OK] Resource server aman untuk memulai deploy.")

        # 1) Cek git status + pull (LOGIC TIDAK DIUBAH dari versi sebelumnya)
        log_stage("[1/11] Cek status Git di server ...")
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
            print(f"   [INFO] {len(safety_paths)} file safety tooling belum di-commit di server (WAJAR, dikirim manual lewat SFTP):")
            for p in safety_paths:
                print(f"            - {p}")
        if confirmed_paths:
            print(f"   [INFO] {len(confirmed_paths)} file fitur yang SUDAH DIKONFIRMASI pemilik project sebagai kondisi production yang disengaja:")
            for p in confirmed_paths:
                print(f"            - {p}")
        if unknown_paths:
            print("\n[PERINGATAN] Ditemukan perubahan file yang TIDAK DIKENALI sebagai file safety:")
            for p in unknown_paths:
                print(f"     - {p}")
            print("Proses DIHENTIKAN — ini mengindikasikan ada perubahan fitur/kode lain")
            print("yang belum jelas statusnya di server. Deploy tidak boleh lanjut sebelum")
            print("ini dikonfirmasi manual oleh pemilik project.")
            return False
        print("[OK] Tidak ada perubahan tak dikenal di server.")

        log_stage("[1/11] git pull origin master ...")
        out, err, code = run_remote(client, f"cd {remote_project} && git pull origin master 2>&1", timeout=120)
        print(out.strip())
        if code != 0:
            print("[STOP] git pull gagal. Deploy dihentikan.")
            return False

        out, _, _ = run_remote(client, f"cd {remote_project} && git rev-parse HEAD")
        head_after = out.strip()
        if head_after != head_before:
            print(f"\n[PERINGATAN] git pull menarik commit BARU ({head_before[:12]} -> {head_after[:12]}).")
            if not confirm_new_commit:
                print("Proses DIHENTIKAN untuk konfirmasi manual. Jalankan ulang dengan --confirm-new-commit setelah diverifikasi.")
                return False
            print("[INFO] --confirm-new-commit diberikan — lanjut.")
        else:
            print(f"[OK] HEAD tidak berubah ({head_after[:12]}...) — 'deploy kosong', tidak ada kode baru.")

        # 2) Preflight check aplikasi (TIDAK DIUBAH)
        log_stage("[2/11] Preflight check aplikasi di server ...")
        out, err, code = run_remote(client, f"cd {remote_project} && node backend/scripts/preflight-check.js --production", timeout=60)
        print(out.strip())
        if code != 0:
            print("[STOP] Preflight check berstatus FAIL. Deploy DIHENTIKAN.")
            return False
        print("[OK] Preflight check lolos (PASS/WARNING, bukan FAIL).")

        # 3) Klasifikasi perubahan
        log_stage("[3/11] Klasifikasi perubahan (frontend/backend/docs-only) ...")
        if head_after == head_before:
            changed_since = []
            print("   HEAD tidak berubah -- tidak ada file yang perlu diklasifikasi (deploy kosong).")
        else:
            out, _, _ = run_remote(client, f"cd {remote_project} && git diff --name-only {head_before} {head_after}")
            changed_since = [l for l in out.strip().splitlines() if l.strip()]
        classification = classify_changed_paths(changed_since)
        print(f"   Frontend berubah: {classification['frontend_changed']}")
        print(f"   Backend berubah:  {classification['backend_changed']}")
        if classification["unclassified_paths"]:
            print(f"   File tak terklasifikasi (tidak memicu build/reload apa pun): {classification['unclassified_paths']}")

        need_build = classification["frontend_changed"] or bool(prebuilt_frontend)
        need_pm2_reload = classification["backend_changed"]

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        release_path = None

        # 4-7) Build/prebuilt + verifikasi + switch atomic — HANYA kalau frontend berubah
        if not need_build:
            print("\n>>> [4-7/11] Frontend TIDAK berubah — build & release switch DILEWATI sepenuhnya.")
        else:
            log_stage("[4/11] Resource gate sebelum build ...")
            snapshot_pre_build = fetch_resource_snapshot(run_remote, client, remote_project)
            ok, reasons = evaluate_resource_gate(snapshot_pre_build, DEFAULT_THRESHOLDS)
            if not ok:
                print("\n[STOP] Deploy ditunda karena resource server sedang tinggi.")
                for r in reasons:
                    print(f"       - {r}")
                return False
            print("   [OK] Resource aman untuk build.")

            release_path = new_release_dir(remote_frontend, ts)
            run_remote(client, f"mkdir -p {release_path}")

            if prebuilt_frontend:
                log_stage(f"[5/11] Mode prebuilt-frontend: upload {prebuilt_frontend} ...")
                local_checksum = prebuilt_checksum or compute_local_sha256(prebuilt_frontend)
                remote_tarball = f"/tmp/bric_prebuilt_{ts}.tar.gz"
                sftp = client.open_sftp()
                sftp.put(prebuilt_frontend, remote_tarball)
                sftp.close()
                remote_checksum = compute_remote_sha256(run_remote, client, remote_tarball)
                if remote_checksum != local_checksum:
                    print(f"[STOP] Checksum tarball TIDAK COCOK (lokal {local_checksum}, di server {remote_checksum}). Deploy DIHENTIKAN, artifact tidak dipakai.")
                    return False
                print(f"   [OK] Checksum cocok ({remote_checksum[:16]}...).")
                out, err, code = run_remote(client, f"tar -xzf {remote_tarball} -C {release_path} && rm -f {remote_tarball} && echo EXTRACT_OK", timeout=60)
                if "EXTRACT_OK" not in out:
                    print(f"[STOP] Gagal extract artifact. Detail: {err or out}")
                    return False
                build_result = {"success": True, "duration_seconds": 0}
            else:
                log_stage("[5/11] Build frontend (low-priority, dipantau) ...")
                build_result = run_build_with_monitor(
                    run_remote, client, f"{remote_project}/frontend", remote_project, ts,
                    poll_interval_seconds=BUILD_MONITOR_DEFAULTS["POLL_INTERVAL_SECONDS"],
                    critical_load1_per_cpu=BUILD_MONITOR_DEFAULTS["CRITICAL_LOAD1_PER_CPU"],
                    critical_min_available_ram_mb=BUILD_MONITOR_DEFAULTS["CRITICAL_MIN_AVAILABLE_RAM_MB"],
                    sustained_breaches_to_abort=BUILD_MONITOR_DEFAULTS["SUSTAINED_BREACHES_TO_ABORT"],
                    max_build_seconds=BUILD_MONITOR_DEFAULTS["MAX_BUILD_SECONDS"],
                    log_fn=print,
                )
                print(f"   {build_result['reason']} (durasi {build_result['duration_seconds']:.1f}s)")
                if not build_result["success"]:
                    print("[STOP] Build GAGAL/DIHENTIKAN. TIDAK ADA yang disalin ke production. Frontend production yang tayang TIDAK diubah.")
                    return False
                out, err, code = run_remote(client, f"cp -r {remote_project}/frontend/dist/* {release_path}/ && echo COPY_OK", timeout=60)
                if "COPY_OK" not in out:
                    print(f"[STOP] Gagal menyalin hasil build ke folder release. Detail: {err or out}")
                    return False

            log_stage("[6/11] Verifikasi isi release baru ...")
            ok, msg = verify_release_contents(run_remote, client, release_path)
            print(f"   {msg}")
            if not ok:
                print("[STOP] Release baru tidak lengkap. TIDAK di-switch ke production.")
                return False

            log_stage("[7/11] Switch rilis frontend ATOMIC ...")
            previous_release_for_rollback, was_bootstrap = bootstrap_or_switch(run_remote, client, remote_frontend, release_path)
            switched_release = True
            if was_bootstrap:
                print(f"   [INFO] Konversi pertama kali ke pola release+symlink. Isi lama diarsipkan di: {previous_release_for_rollback}")
            else:
                print(f"   [OK] Rilis di-switch. Rilis sebelumnya (utk rollback): {previous_release_for_rollback}")

        # 8) PM2 reload HANYA kalau backend berubah
        if not need_pm2_reload:
            print("\n>>> [8/11] Backend TIDAK berubah — PM2 reload DILEWATI.")
        else:
            log_stage(f"[8/11] Reload backend: {PM2_RELOAD_COMMAND}")
            out, err, code = run_remote(client, PM2_RELOAD_COMMAND, timeout=60)
            print(out.strip())
            if code != 0:
                print("[PERINGATAN] Perintah reload PM2 melaporkan error. Cek manual ke server.")

        # 9) Health check
        log_stage(f"[9/11] Cek kesehatan backend: {HEALTH_CHECK_URL}")
        out, err, code = run_remote(client, f"sleep 2 && curl -s {HEALTH_CHECK_URL}", timeout=30)
        print("Response:", out.strip() or "(tidak ada response)")

        if "ok" not in out.lower():
            print("\n[GAGAL] Health check TIDAK menunjukkan status sehat.")
            if switched_release and previous_release_for_rollback:
                log_stage("Rollback OTOMATIS frontend ke rilis sebelumnya ...")
                try:
                    rollback_to(run_remote, client, remote_frontend, previous_release_for_rollback)
                    print(f"   [OK] Frontend di-rollback ke: {previous_release_for_rollback}")
                except Exception as e:
                    print(f"   [GAGAL] Rollback otomatis gagal: {e}")
                    print(f"   Rollback manual: ln -sfn {previous_release_for_rollback} {remote_frontend}")
            print("=== INSTRUKSI LANJUTAN ===")
            print(f"  Backend TIDAK di-rollback otomatis oleh script ini.")
            print(f"  Kalau backend juga bermasalah, gunakan 'git log' + 'git revert' di server,")
            print(f"  lalu jalankan lagi: {PM2_RELOAD_COMMAND}")
            print(f"  Setelah rollback, cek lagi: curl {HEALTH_CHECK_URL}")
            return False

        # 10) Post-deploy resource check + verifikasi akhir
        log_stage("[10/11] Post-deploy resource check + verifikasi akhir ...")
        snapshot_after = fetch_resource_snapshot(run_remote, client, remote_project)
        print(f"   Snapshot resource sesudah deploy:\n{format_snapshot_report(snapshot_after)}")
        ok_after, reasons_after = evaluate_resource_gate(snapshot_after, DEFAULT_THRESHOLDS)
        if not ok_after:
            print("   [PERINGATAN] Resource server KRITIS setelah deploy:")
            for r in reasons_after:
                print(f"       - {r}")
            print("   Deploy tetap dianggap selesai (health check sudah OK), tapi PANTAU server manual.")

        out, _, _ = run_remote(client, "sudo -u admin pm2 list 2>&1")
        print(out.strip())
        restart_after = get_pm2_restart_count(client)
        print(f"   Jumlah restart PM2 SEBELUM: {restart_before if restart_before is not None else '?'}, SESUDAH: {restart_after if restart_after is not None else '?'}")
        if need_pm2_reload and restart_before is not None and restart_after is not None:
            delta = restart_after - restart_before
            if delta == 1:
                print("   [OK] Restart bertambah tepat 1 kali.")
            elif delta > 1:
                print(f"   [PERHATIAN] Restart bertambah {delta} kali — cek log PM2 manual.")
            else:
                print("   [PERHATIAN] Jumlah restart tidak bertambah seperti yang diharapkan — cek manual.")
        elif not need_pm2_reload and restart_before is not None and restart_after is not None and restart_after != restart_before:
            print(f"   [PERHATIAN] PM2 tidak seharusnya reload (backend tidak berubah), tapi restart count berubah ({restart_before} -> {restart_after}) — kemungkinan crash/restart di luar deploy ini, cek log PM2 manual.")

        # 11) Prune rilis lama
        if switched_release:
            log_stage("[11/11] Prune rilis frontend lama (retensi 5) ...")
            print(f"   {prune_old_releases(run_remote, client, remote_frontend, keep=5)}")

        print("\n>>> Deploy selesai. Backend melaporkan status sehat.")
        print("\n=== RINGKASAN TIMING TAHAP ===")
        for label, seconds in stage_timings.items():
            print(f"   {label}: {seconds}s")
        return True
    finally:
        if lock_acquired:
            release_lock(run_remote, client, remote_project)
        client.close()


def main():
    execute_mode = "--execute" in sys.argv
    explicit_dry_run = "--dry-run" in sys.argv
    confirm_new_commit = "--confirm-new-commit" in sys.argv

    prebuilt_frontend = None
    prebuilt_checksum = None
    for i, arg in enumerate(sys.argv):
        if arg == "--prebuilt-frontend" and i + 1 < len(sys.argv):
            prebuilt_frontend = sys.argv[i + 1]
        if arg == "--prebuilt-checksum" and i + 1 < len(sys.argv):
            prebuilt_checksum = sys.argv[i + 1]

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
    success = run_deploy(config, confirm_new_commit=confirm_new_commit, prebuilt_frontend=prebuilt_frontend, prebuilt_checksum=prebuilt_checksum)

    print()
    print("=== Deploy SELESAI (sukses) ===" if success else "=== Deploy DIHENTIKAN / GAGAL — lihat pesan di atas ===")


if __name__ == "__main__":
    main()
