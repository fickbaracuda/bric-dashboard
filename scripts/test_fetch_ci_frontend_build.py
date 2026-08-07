"""
scripts/test_fetch_ci_frontend_build.py

Test logic PURE di fetch_ci_frontend_build.py (tidak ada panggilan 'gh'
sungguhan, tidak ada network) -- pola sama seperti test_deploy_hardening.py.

Run: python scripts/test_fetch_ci_frontend_build.py
"""

import hashlib
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_ci_frontend_build import select_matching_run, compute_sha256, locate_artifact_files  # noqa: E402

passed = 0
failed = 0


def check(name, condition):
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}")


# ── select_matching_run ──────────────────────────────────────────────
RUNS_SAMPLE = [
    {"databaseId": 3, "headSha": "abc123", "status": "completed", "conclusion": "failure", "createdAt": "2026-08-07T10:00:00Z"},
    {"databaseId": 2, "headSha": "abc123", "status": "completed", "conclusion": "success", "createdAt": "2026-08-07T09:00:00Z"},
    {"databaseId": 1, "headSha": "def456", "status": "completed", "conclusion": "success", "createdAt": "2026-08-06T09:00:00Z"},
]

check(
    "select_matching_run: pilih run SUKSES untuk sha yang cocok (skip yang gagal)",
    select_matching_run(RUNS_SAMPLE, "abc123") == RUNS_SAMPLE[1],
)
check(
    "select_matching_run: sha tidak ditemukan -> None",
    select_matching_run(RUNS_SAMPLE, "nonexistent") is None,
)
check(
    "select_matching_run: run masih in_progress (belum completed) -> tidak dipilih",
    select_matching_run(
        [{"databaseId": 9, "headSha": "xyz", "status": "in_progress", "conclusion": None, "createdAt": "now"}],
        "xyz",
    ) is None,
)
check(
    "select_matching_run: list kosong -> None",
    select_matching_run([], "abc123") is None,
)

# ── compute_sha256 ────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    p = Path(td) / "sample.txt"
    p.write_bytes(b"hello bric mpng3")
    expected = hashlib.sha256(b"hello bric mpng3").hexdigest()
    check("compute_sha256: konsisten dengan hashlib langsung", compute_sha256(p) == expected)

# ── locate_artifact_files ─────────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    base = Path(td)
    nested = base / "frontend-dist-abc123"
    nested.mkdir()
    (nested / "frontend-dist.tar.gz").write_bytes(b"fake-tarball")
    (nested / "frontend-dist.sha256").write_text("deadbeef")
    tarball, checksum = locate_artifact_files(base)
    check("locate_artifact_files: menemukan tarball di subfolder nested", tarball is not None and tarball.name == "frontend-dist.tar.gz")
    check("locate_artifact_files: menemukan file checksum di subfolder nested", checksum is not None and checksum.name == "frontend-dist.sha256")

with tempfile.TemporaryDirectory() as td:
    tarball, checksum = locate_artifact_files(Path(td))
    check("locate_artifact_files: folder kosong -> (None, None)", tarball is None and checksum is None)

print(f"\n{passed} passed, {failed} failed ({passed + failed} total)")
if failed:
    sys.exit(1)
