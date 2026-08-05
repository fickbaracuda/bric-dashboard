"""
scripts/deploy_release_manager.py

Atomic frontend release -- menggantikan pola lama `cp -r dist/* /var/www/bric/`
(partial overwrite yang bisa membuat nginx menyajikan CAMPURAN file lama+baru
selama proses copy, dan tidak punya cara instan untuk rollback).

Pola baru: releases + symlink (dipilih krn kompatibel 100% dengan nginx
existing -- `root /var/www/bric;` di nginx-bric.conf, TIDAK PERLU ubah
konfigurasi/reload nginx sama sekali, nginx otomatis mengikuti target
symlink saat ini tanpa cache basi krn tidak ada `open_file_cache` di config):

  /var/www/bric-releases/<timestamp>/   <- isi dist lengkap per rilis
  /var/www/bric                          <- SYMLINK ke salah satu folder di atas

Switch rilis = re-point symlink (operasi atomic di level filesystem).
Rollback = re-point ke rilis sebelumnya (sama-sama atomic & instan).

BOOTSTRAP (satu kali, dideteksi otomatis): saat /var/www/bric MASIH direktori
asli (belum pernah pakai pola ini), dikonversi ke symlink dgn urutan yang
meminimalkan window downtime ke satu system call `mv` diikuti satu `ln -sfn`
dieksekusi back-to-back (sub-milidetik, jauh lebih singkat dari `cp -r`
berulang file yang bisa makan waktu detik-an dgn window inkonsistensi PANJANG).
"""

import hashlib
from datetime import datetime


RELEASES_DIRNAME = "bric-releases"


def releases_root(remote_frontend_path: str) -> str:
    """/var/www/bric -> /var/www/bric-releases"""
    parent = remote_frontend_path.rstrip("/").rsplit("/", 1)[0]
    return f"{parent}/{RELEASES_DIRNAME}"


def new_release_dir(remote_frontend_path: str, timestamp: str = None) -> str:
    ts = timestamp or datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{releases_root(remote_frontend_path)}/{ts}"


def is_symlink(run_remote_fn, client, path: str) -> bool:
    out, _, code = run_remote_fn(client, f"[ -L {path} ] && echo YES || echo NO")
    return out.strip() == "YES"


def verify_release_contents(run_remote_fn, client, release_dir: str) -> "tuple[bool, str]":
    """Cek index.html ada + minimal 1 file di folder assets (nama folder bisa beda2 tergantung config Vite -- cek 'ada isi selain index.html' secara generik)."""
    out, _, code = run_remote_fn(client, f"[ -f {release_dir}/index.html ] && echo INDEX_OK || echo INDEX_MISSING")
    if "INDEX_OK" not in out:
        return False, f"index.html tidak ditemukan di {release_dir}."
    out, _, code = run_remote_fn(client, f"find {release_dir} -type f | wc -l")
    try:
        file_count = int(out.strip())
    except ValueError:
        file_count = 0
    if file_count < 2:
        return False, f"Release di {release_dir} cuma berisi {file_count} file (index.html doang) -- build kemungkinan tidak lengkap."
    return True, f"OK ({file_count} file, index.html ada)."


def bootstrap_or_switch(run_remote_fn, client, remote_frontend_path: str, new_release_path: str) -> "tuple[str, bool]":
    """
    Pindahkan symlink /var/www/bric supaya menunjuk ke new_release_path.

    Return (previous_release_path_or_None, was_bootstrap: bool).
      - previous_release_path: folder rilis SEBELUMNYA (utk rollback), atau
        None kalau ini pertama kali (tidak ada rilis sebelumnya utk di-rollback).
      - was_bootstrap: True kalau ini konversi pertama kali dari direktori asli ke symlink.
    """
    already_symlink = is_symlink(run_remote_fn, client, remote_frontend_path)

    if already_symlink:
        # Baca target lama SEBELUM diganti (utk rollback reference).
        out, _, _ = run_remote_fn(client, f"readlink -f {remote_frontend_path}")
        previous = out.strip() or None

        # Atomic re-point: buat symlink baru dgn nama sementara, lalu `mv -T`
        # (rename() syscall tunggal, atomic di filesystem yang sama) menimpa
        # symlink lama. LEBIH aman drpd `ln -sfn` langsung (perilaku -f pada
        # `ln` bisa beda antar versi coreutils soal atomicity).
        tmp_link = f"{remote_frontend_path}.tmp_{new_release_path.rsplit('/', 1)[-1]}"
        cmd = (
            f"ln -sfn {new_release_path} {tmp_link} && "
            f"mv -T {tmp_link} {remote_frontend_path} && echo SWITCH_OK"
        )
        out, err, code = run_remote_fn(client, cmd, timeout=30)
        if "SWITCH_OK" not in out:
            raise RuntimeError(f"Gagal switch symlink rilis. Detail: {err or out}")
        return previous, False

    # Belum pernah bootstrap -- /var/www/bric MASIH direktori asli berisi file.
    # Pindahkan isi lama jadi salah satu "rilis" (utk rollback), lalu buat
    # symlink baru. Dua perintah dirangkai `&&` dieksekusi back-to-back dalam
    # SATU koneksi SSH (bukan dua request terpisah) supaya window downtime
    # minimal (sub-detik, jauh lebih singkat drpd `cp -r` yang lama).
    bootstrap_original = f"{releases_root(remote_frontend_path)}/bootstrap_original_{new_release_path.rsplit('/', 1)[-1]}"
    cmd = (
        f"mv {remote_frontend_path} {bootstrap_original} && "
        f"ln -sfn {new_release_path} {remote_frontend_path} && echo BOOTSTRAP_OK"
    )
    out, err, code = run_remote_fn(client, cmd, timeout=30)
    if "BOOTSTRAP_OK" not in out:
        raise RuntimeError(f"Gagal bootstrap konversi ke pola release+symlink. Detail: {err or out}")
    return bootstrap_original, True


def rollback_to(run_remote_fn, client, remote_frontend_path: str, previous_release_path: str):
    """Kembalikan symlink ke rilis sebelumnya -- sama-sama atomic (lihat bootstrap_or_switch)."""
    tmp_link = f"{remote_frontend_path}.tmp_rollback"
    cmd = (
        f"ln -sfn {previous_release_path} {tmp_link} && "
        f"mv -T {tmp_link} {remote_frontend_path} && echo ROLLBACK_OK"
    )
    out, err, code = run_remote_fn(client, cmd, timeout=30)
    if "ROLLBACK_OK" not in out:
        raise RuntimeError(f"Gagal rollback symlink. Detail: {err or out}")


def prune_old_releases(run_remote_fn, client, remote_frontend_path: str, keep: int = 5) -> str:
    """
    Hapus rilis lama di bric-releases/, SISAKAN `keep` yang terbaru (urut nama
    folder -- format timestamp YYYYMMDD_HHMMSS sortable secara leksikografis)
    DAN folder yang SEDANG dipakai symlink saat ini (tidak pernah dihapus
    walau bukan termasuk N terbaru, supaya production tidak pernah kehilangan
    rilis yang sedang live).
    """
    out, _, _ = run_remote_fn(client, f"readlink -f {remote_frontend_path}")
    current_target = out.strip()

    root = releases_root(remote_frontend_path)
    out, _, code = run_remote_fn(client, f"ls -1 {root} 2>/dev/null | sort")
    if code != 0 or not out.strip():
        return "Tidak ada rilis lama utk dibersihkan."
    all_releases = [f"{root}/{name}" for name in out.strip().splitlines() if name.strip()]

    to_keep = set(all_releases[-keep:]) if keep > 0 else set()
    to_keep.add(current_target)
    to_delete = [r for r in all_releases if r not in to_keep]

    if not to_delete:
        return f"Semua {len(all_releases)} rilis lama masih dalam batas retensi ({keep}), tidak ada yang dihapus."

    delete_cmd = " ".join(f"'{r}'" for r in to_delete)
    run_remote_fn(client, f"rm -rf {delete_cmd}", timeout=60)
    return f"Dihapus {len(to_delete)} rilis lama (disisakan {len(to_keep)}, termasuk yang sedang live)."


def compute_remote_sha256(run_remote_fn, client, remote_path: str) -> "str | None":
    """sha256sum dari file di server (dipakai verifikasi mode prebuilt-artifact)."""
    out, _, code = run_remote_fn(client, f"sha256sum {remote_path} 2>/dev/null | awk '{{print $1}}'")
    val = out.strip()
    return val if code == 0 and val else None


def compute_local_sha256(local_path: str) -> str:
    h = hashlib.sha256()
    with open(local_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()
