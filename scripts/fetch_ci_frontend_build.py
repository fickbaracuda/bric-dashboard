"""
scripts/fetch_ci_frontend_build.py

Ambil hasil build frontend yang SUDAH dibuat oleh GitHub Actions
(.github/workflows/build-frontend.yml) untuk commit tertentu, lalu siapkan
argumen siap-pakai untuk mode `--prebuilt-frontend`/`--prebuilt-checksum`
yang SUDAH ADA di scripts/safe_deploy.py.

Ini BUKAN pengganti gerbang manual DEPLOY -- script ini TIDAK menyambung
ke VPS sama sekali, TIDAK ada credential production di sini. Cuma
menyiapkan file lokal supaya `safe_deploy.py --execute` tidak perlu build
di VPS lagi (lihat docs/DEPLOYMENT_SAFETY.md bagian 14 utk alasan lengkap
kenapa build di VPS berisiko).

Prasyarat:
  - GitHub CLI ('gh') terpasang & sudah login ('gh auth status').
  - Commit yang mau dideploy SUDAH di-push ke origin/master, DAN workflow
    "Build Frontend (offload dari VPS)" untuk commit itu sudah SELESAI
    (bisa dicek juga lewat: https://github.com/<repo>/actions).

Cara pakai:
  python scripts/fetch_ci_frontend_build.py
      -> pakai HEAD lokal branch master sebagai target commit.
  python scripts/fetch_ci_frontend_build.py --sha <commit-sha>
      -> target commit spesifik.

Kalau berhasil, script mencetak PERINTAH SIAP-PAKAI untuk dijalankan
selanjutnya (masih perlu ketik "DEPLOY" seperti biasa):
  python scripts/safe_deploy.py --execute --prebuilt-frontend <path> --prebuilt-checksum <sha256>
"""

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

WORKFLOW_FILE = "build-frontend.yml"
ARTIFACT_PREFIX = "frontend-dist-"


def run_gh(args: list, cwd: str = None) -> "tuple[str, str, int]":
    """Jalankan 'gh <args>', kembalikan (stdout, stderr, returncode). TIDAK raise."""
    try:
        proc = subprocess.run(
            ["gh"] + args, cwd=cwd, capture_output=True, text=True, timeout=120,
        )
        return proc.stdout, proc.stderr, proc.returncode
    except FileNotFoundError:
        return "", "GitHub CLI ('gh') tidak ditemukan di PATH. Install dulu: https://cli.github.com/", 1
    except subprocess.TimeoutExpired:
        return "", "Perintah 'gh' timeout (120s).", 1


def get_local_head_sha(branch: str = "master") -> "str | None":
    try:
        proc = subprocess.run(
            ["git", "rev-parse", branch], capture_output=True, text=True, timeout=10,
        )
        if proc.returncode != 0:
            return None
        return proc.stdout.strip()
    except Exception:
        return None


def find_successful_run_for_sha(sha: str) -> "dict | None":
    """
    Cari workflow run "build-frontend.yml" yang SUKSES untuk commit sha
    tertentu. PURE terhadap parsing JSON (gampang ditest) -- I/O 'gh'
    dipisah supaya bisa dites tanpa panggilan jaringan sungguhan.
    """
    out, err, code = run_gh([
        "run", "list",
        "--workflow", WORKFLOW_FILE,
        "--json", "databaseId,headSha,status,conclusion,createdAt",
        "--limit", "50",
    ])
    if code != 0:
        print(f"[GAGAL] 'gh run list' error: {err.strip() or out.strip()}")
        return None
    try:
        runs = json.loads(out)
    except json.JSONDecodeError:
        print("[GAGAL] Tidak bisa parse output 'gh run list' sebagai JSON.")
        return None
    return select_matching_run(runs, sha)


def select_matching_run(runs: list, sha: str) -> "dict | None":
    """
    PURE — pilih run tersukses yang cocok dengan sha. Testable tanpa 'gh'
    sungguhan. Terurut oleh 'gh' dari yang terbaru duluan, jadi ambil match
    PERTAMA yang statusnya completed+success.
    """
    for run in runs:
        if run.get("headSha") == sha and run.get("status") == "completed" and run.get("conclusion") == "success":
            return run
    return None


def download_artifact(run_id: str, dest_dir: Path) -> bool:
    out, err, code = run_gh(["run", "download", str(run_id), "-D", str(dest_dir)])
    if code != 0:
        print(f"[GAGAL] 'gh run download' error: {err.strip() or out.strip()}")
        return False
    return True


def locate_artifact_files(dest_dir: Path) -> "tuple[Path, Path] | tuple[None, None]":
    """Cari frontend-dist.tar.gz + frontend-dist.sha256 di dalam folder hasil download (nested per-artifact-name)."""
    tarballs = list(dest_dir.rglob("frontend-dist.tar.gz"))
    checksums = list(dest_dir.rglob("frontend-dist.sha256"))
    if not tarballs or not checksums:
        return None, None
    return tarballs[0], checksums[0]


def compute_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", help="Commit SHA target (default: HEAD lokal branch master)")
    args = parser.parse_args()

    print("==============================================================")
    print("  BRIC DASHBOARD — Ambil hasil build frontend dari CI")
    print("==============================================================")

    out, err, code = run_gh(["auth", "status"])
    if code != 0:
        print("[STOP] GitHub CLI belum login. Jalankan 'gh auth login' dulu.")
        print(f"       Detail: {err.strip() or out.strip()}")
        sys.exit(1)

    sha = args.sha or get_local_head_sha("master")
    if not sha:
        print("[STOP] Tidak bisa menentukan commit SHA target (branch 'master' lokal tidak ditemukan).")
        print("       Pastikan Anda berada di repo BRIC dan sudah 'git fetch origin master'.")
        sys.exit(1)
    print(f">>> Commit target: {sha}")

    print(">>> Mencari workflow run 'Build Frontend' yang SUKSES untuk commit ini ...")
    run = find_successful_run_for_sha(sha)
    if not run:
        print("[STOP] Belum ada build CI yang sukses untuk commit ini.")
        print(f"       Cek status workflow di: https://github.com/<repo>/actions/workflows/{WORKFLOW_FILE}")
        print("       Kalau belum jalan sama sekali, push dulu ke 'master' (workflow auto-trigger kalau frontend/ berubah),")
        print("       atau trigger manual lewat GitHub UI (workflow_dispatch).")
        sys.exit(1)
    print(f"[OK] Ditemukan run sukses: id={run['databaseId']}, dibuat {run['createdAt']}")

    tmp_dir = Path(tempfile.mkdtemp(prefix="bric_ci_frontend_"))
    print(f">>> Mengunduh artifact ke: {tmp_dir}")
    if not download_artifact(run["databaseId"], tmp_dir):
        sys.exit(1)

    tarball, checksum_file = locate_artifact_files(tmp_dir)
    if not tarball or not checksum_file:
        print(f"[STOP] Artifact tidak lengkap (tarball/checksum tidak ditemukan) di {tmp_dir}.")
        sys.exit(1)

    recorded_checksum = checksum_file.read_text(encoding="utf-8").strip()
    actual_checksum = compute_sha256(tarball)
    if recorded_checksum != actual_checksum:
        print("[STOP] Checksum artifact TIDAK COCOK (kemungkinan unduhan korup). Batal, tidak dipakai.")
        print(f"       Tercatat: {recorded_checksum}")
        print(f"       Aktual:   {actual_checksum}")
        sys.exit(1)
    print(f"[OK] Checksum artifact terverifikasi: {actual_checksum[:16]}...")

    print("\n=== SIAP DIPAKAI ===")
    print("Jalankan perintah berikut untuk deploy (masih perlu ketik 'DEPLOY' seperti biasa):\n")
    print(f'  python scripts/safe_deploy.py --execute --prebuilt-frontend "{tarball}" --prebuilt-checksum {actual_checksum}\n')
    print("Build frontend TIDAK akan dijalankan di VPS sama sekali pada mode ini.")


if __name__ == "__main__":
    main()
