"""
scripts/deploy_build_monitor.py

Menjalankan `npm run build` sebagai proses low-priority yang BISA dipantau
dan diberhentikan dengan aman -- ini langsung memperbaiki bug nyata yang
ditemukan saat audit: `deploy_common.run_remote()` memakai
`paramiko Channel.exec_command(timeout=N)`, dan timeout itu HANYA
menghentikan pembacaan LOKAL (di komputer developer) -- TIDAK PERNAH
mengirim sinyal apa pun ke proses di server. Kalau build macet/lambat,
proses `npm run build` sebelumnya bisa terus berjalan di server SELAMANYA,
tak terlihat, terus makan CPU/RAM, walau script lokal sudah melaporkan
"gagal" dan berhenti.

Solusi di sini: build dijalankan via `setsid` (jadi punya process group
sendiri) di background, PID grup dicatat, lalu dipantau via polling
terpisah (bukan menunggu di satu exec_command yang panjang). Kalau harus
diberhentikan, HANYA process group build ini yang dikirim sinyal --
TIDAK PERNAH pkill/killall node, TIDAK PERNAH menyentuh proses PM2.
"""

import time

from deploy_resource_guard import fetch_resource_snapshot, format_snapshot_report
from deploy_change_classifier import classify_changed_paths  # noqa: F401  (re-export convenience, tidak dipakai langsung di sini)


BUILD_LOG_PATH_TEMPLATE = "/tmp/bric_deploy_build_{ts}.log"


def start_build(run_remote_fn, client, remote_frontend_dir: str, ts: str) -> "tuple[int, str]":
    """
    Mulai `npm run build` sbg proses low-priority, terpisah dari sesi SSH ini
    (setsid) supaya bisa dipantau via polling, bukan diblokir menunggu di
    satu exec_command panjang.

    ionice/nice dipakai KALAU tersedia; kalau tidak ada di server, fallback
    otomatis jalan tanpa keduanya (TIDAK gagal hanya krn low-priority tooling
    absen -- itu bukan alasan membatalkan seluruh deploy).

    Return (pgid: int, logfile_path: str). Melempar RuntimeError kalau gagal start.
    """
    logfile = BUILD_LOG_PATH_TEMPLATE.format(ts=ts)

    # Cek ketersediaan ionice sekali di depan -- daripada command gagal
    # senyap kalau tidak ada.
    out, _, _ = run_remote_fn(client, "command -v ionice >/dev/null 2>&1 && echo YES || echo NO")
    has_ionice = out.strip() == "YES"
    priority_prefix = "ionice -c2 -n7 nice -n 15" if has_ionice else "nice -n 15"

    cmd = (
        f"cd {remote_frontend_dir} && "
        f"setsid bash -c '{priority_prefix} npm run build > {logfile} 2>&1; "
        f"echo BUILD_EXIT_CODE:$? >> {logfile}' "
        f"< /dev/null > /dev/null 2>&1 & echo PGID:$!"
    )
    out, err, code = run_remote_fn(client, cmd, timeout=15)
    for line in out.splitlines():
        if line.startswith("PGID:"):
            try:
                pgid = int(line.split(":", 1)[1].strip())
                return pgid, logfile
            except ValueError:
                pass
    raise RuntimeError(f"Gagal memulai build (tidak dapat PGID). Detail: {err or out}")


def is_process_group_alive(run_remote_fn, client, pgid: int) -> bool:
    out, _, _ = run_remote_fn(client, f"kill -0 -{pgid} 2>/dev/null && echo ALIVE || echo DEAD")
    return out.strip() == "ALIVE"


def read_build_exit_code(run_remote_fn, client, logfile: str) -> "int | None":
    out, _, _ = run_remote_fn(client, f"grep -o 'BUILD_EXIT_CODE:[0-9]*' {logfile} 2>/dev/null | tail -1")
    val = out.strip()
    if val.startswith("BUILD_EXIT_CODE:"):
        try:
            return int(val.split(":", 1)[1])
        except ValueError:
            return None
    return None


def terminate_build(run_remote_fn, client, pgid: int):
    """
    Hentikan HANYA process group build ini. TIDAK PERNAH pkill/killall node,
    TIDAK PERNAH menyentuh proses PM2 (yang PGID-nya beda sama sekali).
    TERM dulu (graceful), tunggu sebentar, baru KILL kalau masih hidup.
    """
    run_remote_fn(client, f"kill -TERM -{pgid} 2>/dev/null")
    time.sleep(2)
    if is_process_group_alive(run_remote_fn, client, pgid):
        run_remote_fn(client, f"kill -KILL -{pgid} 2>/dev/null")


def run_build_with_monitor(
    run_remote_fn, client, remote_frontend_dir: str, remote_project: str, ts: str,
    poll_interval_seconds: int, critical_load1_per_cpu: float, critical_min_available_ram_mb: int,
    sustained_breaches_to_abort: int, max_build_seconds: int, log_fn=print,
):
    """
    Orkestrasi penuh: start build -> poll resource & liveness -> abort kalau
    kondisi kritis BERKEPANJANGAN atau timeout -> return hasil.

    Return dict: {
      "success": bool, "aborted": bool, "reason": str,
      "exit_code": int|None, "logfile": str, "duration_seconds": float,
      "last_snapshot": dict|None,
    }
    """
    pgid, logfile = start_build(run_remote_fn, client, remote_frontend_dir, ts)
    log_fn(f"   Build dimulai (process group {pgid}, low-priority), log: {logfile}")

    start_time = time.monotonic()
    consecutive_breaches = 0
    last_snapshot = None

    while True:
        elapsed = time.monotonic() - start_time
        alive = is_process_group_alive(run_remote_fn, client, pgid)

        if not alive:
            exit_code = read_build_exit_code(run_remote_fn, client, logfile)
            success = exit_code == 0
            return {
                "success": success, "aborted": False,
                "reason": "Build selesai normal." if success else f"Build berhenti dengan exit code {exit_code}.",
                "exit_code": exit_code, "logfile": logfile, "duration_seconds": elapsed,
                "last_snapshot": last_snapshot,
            }

        if elapsed > max_build_seconds:
            terminate_build(run_remote_fn, client, pgid)
            return {
                "success": False, "aborted": True,
                "reason": f"Build melebihi batas waktu maksimum ({max_build_seconds}s) -- dihentikan (hanya process group build, PM2/backend tidak disentuh).",
                "exit_code": None, "logfile": logfile, "duration_seconds": elapsed,
                "last_snapshot": last_snapshot,
            }

        last_snapshot = fetch_resource_snapshot(run_remote_fn, client, remote_project)
        cpu_count = last_snapshot.get("cpu_count") or 2
        load1 = last_snapshot.get("load1")
        avail_ram = last_snapshot.get("available_ram_mb")

        critical = False
        if load1 is not None and load1 >= critical_load1_per_cpu * cpu_count:
            critical = True
        if avail_ram is not None and avail_ram < critical_min_available_ram_mb:
            critical = True

        if critical:
            consecutive_breaches += 1
            log_fn(f"   [PERHATIAN] Kondisi resource kritis terdeteksi ({consecutive_breaches}/{sustained_breaches_to_abort}): load1={load1}, available_ram={avail_ram}MB")
        else:
            consecutive_breaches = 0

        if consecutive_breaches >= sustained_breaches_to_abort:
            terminate_build(run_remote_fn, client, pgid)
            return {
                "success": False, "aborted": True,
                "reason": (
                    f"Resource server kritis SECARA BERKEPANJANGAN selama build "
                    f"({consecutive_breaches * poll_interval_seconds}s berturut-turut) -- build dihentikan "
                    f"demi menjaga production tetap dapat diakses. Snapshot terakhir:\n{format_snapshot_report(last_snapshot)}"
                ),
                "exit_code": None, "logfile": logfile, "duration_seconds": elapsed,
                "last_snapshot": last_snapshot,
            }

        time.sleep(poll_interval_seconds)
