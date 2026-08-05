"""
scripts/deploy_lock.py

Deploy lock -- mencegah dua `safe_deploy.py --execute` berjalan bersamaan
terhadap server yang sama (mis. dijalankan dari 2 komputer developer
berbeda di saat yang sama, atau proses lama yang belum benar-benar selesai
karena SSH terputus). Dua deploy build berbarengan di server 2-vCPU/1.6GB
akan melipatgandakan tekanan CPU/RAM persis yang ingin dicegah audit ini.

Lock disimpan di SERVER (bukan lokal) -- `{remote_project}/.deploy.lock`,
berisi PID (proses safe_deploy.py di komputer yang menjalankannya -- bukan
PID di server, murni informasi) + timestamp + hostname lokal, supaya lock
tetap efektif walau dijalankan dari komputer berbeda-beda.

STALE LOCK HANDLING: kalau file lock sudah ada TAPI usianya melebihi
`stale_after_minutes`, dianggap peninggalan proses yang crash/terputus --
lock lama otomatis DIABAIKAN (ditimpa), bukan mengunci deploy selamanya.
"""

import getpass
import os
import socket
import time


LOCK_FILE_REL = ".deploy.lock"
DEFAULT_STALE_AFTER_MINUTES = 20  # build normal + semua langkah lain harusnya jauh di bawah ini


def _lock_path(remote_project: str) -> str:
    return f"{remote_project}/{LOCK_FILE_REL}"


def _local_identity() -> str:
    try:
        user = getpass.getuser()
    except Exception:
        user = "unknown"
    try:
        host = socket.gethostname()
    except Exception:
        host = "unknown-host"
    return f"{user}@{host} pid={os.getpid()}"


def acquire_lock(run_remote_fn, client, remote_project: str, stale_after_minutes: int = DEFAULT_STALE_AFTER_MINUTES):
    """
    Coba ambil lock secara ATOMIC di server pakai `mkdir` (mkdir gagal kalau
    folder sudah ada -- operasi atomic di filesystem POSIX, TIDAK ada race
    window seperti pola "cek file ada dulu baru tulis").

    Return (acquired: bool, message: str).
    """
    lock_dir = _lock_path(remote_project) + ".d"  # pakai mkdir, bukan file biasa -- atomic
    identity = _local_identity()
    now_epoch = int(time.time())

    # 1) Coba mkdir atomic.
    out, err, code = run_remote_fn(
        client,
        f"mkdir {lock_dir} 2>&1 && echo '{identity}|{now_epoch}' > {lock_dir}/info && echo LOCK_ACQUIRED",
    )
    if "LOCK_ACQUIRED" in out:
        return True, f"Lock diperoleh ({identity})."

    # 2) mkdir gagal -- lock sudah ada. Baca info lock existing, cek staleness.
    out, err, code = run_remote_fn(client, f"cat {lock_dir}/info 2>/dev/null")
    existing_info = out.strip()
    existing_epoch = None
    if "|" in existing_info:
        try:
            existing_epoch = int(existing_info.rsplit("|", 1)[1])
        except ValueError:
            existing_epoch = None

    if existing_epoch is not None:
        age_minutes = (now_epoch - existing_epoch) / 60.0
        if age_minutes < stale_after_minutes:
            return False, (
                f"Deploy LAIN sedang berjalan (lock: {existing_info}, umur {age_minutes:.1f} menit). "
                f"Tunggu sampai selesai, atau kalau yakin itu proses macet, cek manual di server."
            )
        # Stale -- ambil alih lock (hapus punya lama, buat baru).
        out2, err2, code2 = run_remote_fn(
            client,
            f"rm -rf {lock_dir} && mkdir {lock_dir} && echo '{identity}|{now_epoch}' > {lock_dir}/info && echo LOCK_ACQUIRED",
        )
        if "LOCK_ACQUIRED" in out2:
            return True, f"Lock lama sudah STALE (umur {age_minutes:.1f} menit, milik {existing_info}) -- diambil alih."
        return False, f"Gagal mengambil alih lock stale. Detail: {err2 or out2}"

    # Tidak bisa baca info lock sama sekali (kosong/rusak) -- fail-closed, jangan asumsikan aman.
    return False, f"Lock sudah ada tapi info-nya tidak bisa dibaca ({existing_info!r}) -- fail-closed, tidak lanjut deploy."


def release_lock(run_remote_fn, client, remote_project: str):
    """Lepas lock (best-effort -- dipanggil di `finally`, tidak melempar exception kalau gagal)."""
    lock_dir = _lock_path(remote_project) + ".d"
    try:
        run_remote_fn(client, f"rm -rf {lock_dir}")
    except Exception:
        pass
