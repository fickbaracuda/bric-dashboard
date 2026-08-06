"""
scripts/test_deploy_hardening.py

Test manual pakai `assert` polos (pola sama dengan test JS di
backend/scripts/test-*.js -- project ini belum punya test framework resmi).
SEMUA test di sini murni (tidak ada koneksi SSH sungguhan) -- fungsi yang
butuh SSH (fetch_resource_snapshot, acquire_lock, bootstrap_or_switch, dst)
dites dgn `run_remote_fn` PALSU (fake, bukan mock library) yang mengembalikan
jawaban terskenario, sama seperti pola backend/scripts/test-balance-funding-
adapters.js yang mock `pool.query`.

Run: python scripts/test_deploy_hardening.py
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from deploy_resource_guard import (
    parse_free_output, parse_uptime_loadavg, parse_df_output,
    evaluate_resource_gate, fetch_resource_snapshot, DEFAULT_THRESHOLDS,
)
from deploy_change_classifier import classify_changed_paths
from deploy_lock import acquire_lock, release_lock, DEFAULT_STALE_AFTER_MINUTES
from deploy_release_manager import (
    releases_root, new_release_dir, is_symlink, verify_release_contents,
    bootstrap_or_switch, prune_old_releases, compute_local_sha256,
)
from deploy_build_monitor import start_build, _try_recover_running_build

tests = []


def test(name, fn):
    tests.append((name, fn))


def assert_eq(actual, expected, msg=""):
    if actual != expected:
        raise AssertionError(f"{msg} -- expected {expected!r}, got {actual!r}")


def assert_true(val, msg=""):
    if not val:
        raise AssertionError(f"{msg} -- expected truthy, got {val!r}")


def assert_false(val, msg=""):
    if val:
        raise AssertionError(f"{msg} -- expected falsy, got {val!r}")


class FakeRunner:
    """
    Runner SSH palsu -- jawab `run_remote(client, cmd, timeout=...)` sesuai
    daftar respons berurutan ATAU sesuai substring pencocokan command
    (dipetakan manual per test), tidak pernah menyambung ke jaringan.
    """
    def __init__(self, responses_by_substring):
        self.responses_by_substring = responses_by_substring
        self.calls = []

    def __call__(self, client, cmd, timeout=60):
        self.calls.append(cmd)
        for substring, response in self.responses_by_substring.items():
            if substring in cmd:
                return response
        raise AssertionError(f"FakeRunner: tidak ada skenario utk command: {cmd!r}")


# ── parse_free_output ──
test("parse_free_output: format standar", lambda: (
    lambda r: (
        assert_eq(r["mem"]["total_mb"], 1608),
        assert_eq(r["mem"]["available_mb"], 324),
        assert_eq(r["swap"]["used_mb"], 0),
    )
)(parse_free_output(
    "              total        used        free      shared  buff/cache   available\n"
    "Mem:            1608         984         102         141         522         324\n"
    "Swap:              0           0           0\n"
)))

# ── parse_uptime_loadavg ──
test("parse_uptime_loadavg: format standar", lambda: (
    lambda r: (assert_eq(r["load1"], 0.20), assert_eq(r["load5"], 0.28))
)(parse_uptime_loadavg(" 21:48:37 up 42 min,  0 users,  load average: 0.20, 0.28, 0.25")))
test("parse_uptime_loadavg: gagal parse -> None", lambda: (
    lambda r: assert_eq(r["load1"], None)
)(parse_uptime_loadavg("garbage output")))

# ── parse_df_output ──
test("parse_df_output: format df -BG", lambda: (
    lambda r: assert_eq(r["avail_gb"], 10.0)
)(parse_df_output("Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda3        40G   28G   10G  74% /\n")))

# ── evaluate_resource_gate ──
test("evaluate_resource_gate: server sehat (kondisi produksi nyata saat audit) -> OK", lambda: (
    lambda ok, reasons: (assert_true(ok), assert_eq(reasons, []))
)(*evaluate_resource_gate({
    "cpu_count": 2, "load1": 0.20, "available_ram_mb": 324, "swap_used_mb": 0,
    "disk_free_gb": 10, "backend_healthy": True, "pm2_online": True, "long_running_queries": 0,
})))
test("evaluate_resource_gate: CPU load tinggi -> STOP", lambda: (
    lambda ok, reasons: (assert_false(ok), assert_true(any("Load average" in r for r in reasons)))
)(*evaluate_resource_gate({
    "cpu_count": 2, "load1": 3.0, "available_ram_mb": 324, "swap_used_mb": 0,
    "disk_free_gb": 10, "backend_healthy": True, "pm2_online": True, "long_running_queries": 0,
})))
test("evaluate_resource_gate: RAM available rendah -> STOP", lambda: (
    lambda ok, reasons: (assert_false(ok), assert_true(any("RAM available" in r for r in reasons)))
)(*evaluate_resource_gate({
    "cpu_count": 2, "load1": 0.2, "available_ram_mb": 100, "swap_used_mb": 0,
    "disk_free_gb": 10, "backend_healthy": True, "pm2_online": True, "long_running_queries": 0,
})))
test("evaluate_resource_gate: backend tidak sehat -> STOP", lambda: (
    lambda ok, reasons: (assert_false(ok), assert_true(any("Backend TIDAK sehat" in r for r in reasons)))
)(*evaluate_resource_gate({
    "cpu_count": 2, "load1": 0.2, "available_ram_mb": 324, "swap_used_mb": 0,
    "disk_free_gb": 10, "backend_healthy": False, "pm2_online": True, "long_running_queries": 0,
})))
test("evaluate_resource_gate: field tidak terbaca (None) -> fail-closed, STOP", lambda: (
    lambda ok, reasons: (assert_false(ok), assert_true(any("fail-closed" in r for r in reasons)))
)(*evaluate_resource_gate({
    "cpu_count": None, "load1": None, "available_ram_mb": 324, "swap_used_mb": 0,
    "disk_free_gb": 10, "backend_healthy": True, "pm2_online": True, "long_running_queries": 0,
})))
test("evaluate_resource_gate: swap terpakai -> STOP walau CPU/RAM keliatan OK", lambda: (
    lambda ok, reasons: (assert_false(ok), assert_true(any("Swap" in r for r in reasons)))
)(*evaluate_resource_gate({
    "cpu_count": 2, "load1": 0.2, "available_ram_mb": 324, "swap_used_mb": 500,
    "disk_free_gb": 10, "backend_healthy": True, "pm2_online": True, "long_running_queries": 0,
})))
test("evaluate_resource_gate: query PostgreSQL long-running berlebihan -> STOP (proxy sync/import berat)", lambda: (
    lambda ok, reasons: (assert_false(ok), assert_true(any("query PostgreSQL aktif" in r for r in reasons)))
)(*evaluate_resource_gate({
    "cpu_count": 2, "load1": 0.2, "available_ram_mb": 324, "swap_used_mb": 0,
    "disk_free_gb": 10, "backend_healthy": True, "pm2_online": True, "long_running_queries": 10,
})))
test("evaluate_resource_gate: disk hampir penuh -> STOP", lambda: (
    lambda ok, reasons: (assert_false(ok), assert_true(any("Disk tersisa" in r for r in reasons)))
)(*evaluate_resource_gate({
    "cpu_count": 2, "load1": 0.2, "available_ram_mb": 324, "swap_used_mb": 0,
    "disk_free_gb": 1, "backend_healthy": True, "pm2_online": True, "long_running_queries": 0,
})))

# ── classify_changed_paths ──
def _t_classify_frontend_only():
    r = classify_changed_paths(["frontend/src/pages/Foo.jsx", "frontend/src/index.css"])
    assert_true(r["frontend_changed"])
    assert_false(r["backend_changed"])
    assert_false(r["docs_or_tooling_only"])
test("classify_changed_paths: frontend-only -> frontend_changed True, backend_changed False", _t_classify_frontend_only)

def _t_classify_backend_only():
    r = classify_changed_paths(["backend/src/routes/foo.js"])
    assert_false(r["frontend_changed"])
    assert_true(r["backend_changed"])
test("classify_changed_paths: backend-only -> backend_changed True, frontend_changed False", _t_classify_backend_only)

def _t_classify_docs_only():
    r = classify_changed_paths(["docs/FOO.md", "CLAUDE.md", "scripts/some_tool.py"])
    assert_false(r["frontend_changed"])
    assert_false(r["backend_changed"])
    assert_true(r["docs_or_tooling_only"])
test("classify_changed_paths: docs/scripts-only -> tidak memicu build/reload apa pun", _t_classify_docs_only)

def _t_classify_mixed():
    r = classify_changed_paths(["frontend/src/App.jsx", "backend/src/app.js"])
    assert_true(r["frontend_changed"])
    assert_true(r["backend_changed"])
test("classify_changed_paths: frontend+backend -> keduanya True", _t_classify_mixed)

def _t_classify_empty():
    r = classify_changed_paths([])
    assert_false(r["frontend_changed"])
    assert_false(r["backend_changed"])
    assert_true(r["docs_or_tooling_only"])
test("classify_changed_paths: deploy kosong (tidak ada file berubah) -> tidak build/reload apa pun", _t_classify_empty)

def _t_classify_unclassified_root_file():
    r = classify_changed_paths(["deploy_full.py", "apps-script-bumdes.js"])
    assert_false(r["frontend_changed"])
    assert_false(r["backend_changed"])
    assert_eq(len(r["unclassified_paths"]), 2)
test("classify_changed_paths: root-level script lama -> tidak memicu build/reload, dicatat sbg unclassified", _t_classify_unclassified_root_file)


# ── deploy_lock ──
def _t_lock_acquire_fresh():
    runner = FakeRunner({
        "mkdir": ("LOCK_ACQUIRED\n", "", 0),
    })
    acquired, msg = acquire_lock(runner, None, "/home/admin/bric-dashboard")
    assert_true(acquired)
test("acquire_lock: lock belum ada -> berhasil diambil (mkdir atomic)", _t_lock_acquire_fresh)

def _t_lock_blocked_fresh_lock():
    now = int(time.time())
    responses = {
        f"mkdir {' '.join([])}": None,  # placeholder, tidak dipakai
    }
    def runner(client, cmd, timeout=60):
        if cmd.startswith("mkdir "):
            return ("mkdir: cannot create directory\n", "", 1)
        if cmd.startswith("cat "):
            return (f"owner@otherhost pid=999|{now}\n", "", 0)
        raise AssertionError(f"unexpected cmd: {cmd}")
    acquired, msg = acquire_lock(runner, None, "/home/admin/bric-dashboard", stale_after_minutes=20)
    assert_false(acquired)
    assert_true("Deploy LAIN sedang berjalan" in msg)
test("acquire_lock: lock milik proses lain yang MASIH FRESH -> ditolak (bukan double-deploy)", _t_lock_blocked_fresh_lock)

def _t_lock_stale_takeover():
    old_time = int(time.time()) - (30 * 60)  # 30 menit lalu, melebihi default stale 20 menit
    calls = {"mkdir_count": 0}
    def runner(client, cmd, timeout=60):
        if cmd.startswith("mkdir ") and "rm -rf" not in cmd:
            calls["mkdir_count"] += 1
            return ("mkdir: cannot create directory\n", "", 1)
        if cmd.startswith("cat "):
            return (f"owner@oldhost pid=111|{old_time}\n", "", 0)
        if "rm -rf" in cmd and "mkdir" in cmd:
            return ("LOCK_ACQUIRED\n", "", 0)
        raise AssertionError(f"unexpected cmd: {cmd}")
    acquired, msg = acquire_lock(runner, None, "/home/admin/bric-dashboard", stale_after_minutes=20)
    assert_true(acquired)
    assert_true("STALE" in msg)
test("acquire_lock: lock lama STALE (>20 menit) -> diambil alih otomatis, bukan mengunci selamanya", _t_lock_stale_takeover)

def _t_lock_release():
    calls = []
    def runner(client, cmd, timeout=60):
        calls.append(cmd)
        return ("", "", 0)
    release_lock(runner, None, "/home/admin/bric-dashboard")
    assert_true(any("rm -rf" in c for c in calls))
test("release_lock: memanggil rm -rf pada lock dir", _t_lock_release)


# ── deploy_release_manager ──
test("releases_root: /var/www/bric -> /var/www/bric-releases", lambda: assert_eq(
    releases_root("/var/www/bric"), "/var/www/bric-releases"
))
test("new_release_dir: format timestamp konsisten", lambda: assert_eq(
    new_release_dir("/var/www/bric", "20260805_120000"), "/var/www/bric-releases/20260805_120000"
))

def _t_verify_release_ok():
    def runner(client, cmd, timeout=60):
        if "index.html" in cmd:
            return ("INDEX_OK\n", "", 0)
        if "find" in cmd:
            return ("42\n", "", 0)
        raise AssertionError(cmd)
    ok, msg = verify_release_contents(runner, None, "/var/www/bric-releases/20260805_120000")
    assert_true(ok)
test("verify_release_contents: index.html + banyak file -> OK", _t_verify_release_ok)

def _t_verify_release_missing_index():
    def runner(client, cmd, timeout=60):
        if "index.html" in cmd:
            return ("INDEX_MISSING\n", "", 0)
        raise AssertionError(cmd)
    ok, msg = verify_release_contents(runner, None, "/var/www/bric-releases/broken")
    assert_false(ok)
    assert_true("index.html" in msg)
test("verify_release_contents: index.html tidak ada -> gagal, TIDAK di-switch", _t_verify_release_missing_index)

def _t_verify_release_too_few_files():
    def runner(client, cmd, timeout=60):
        if "index.html" in cmd:
            return ("INDEX_OK\n", "", 0)
        if "find" in cmd:
            return ("1\n", "", 0)  # cuma index.html sendiri
        raise AssertionError(cmd)
    ok, msg = verify_release_contents(runner, None, "/var/www/bric-releases/broken")
    assert_false(ok)
test("verify_release_contents: cuma 1 file (index.html doang, build kemungkinan gagal) -> gagal", _t_verify_release_too_few_files)

def _t_bootstrap_first_time():
    calls = []
    def runner(client, cmd, timeout=60):
        calls.append(cmd)
        if cmd.startswith("[ -L"):
            return ("NO\n", "", 0)  # belum symlink -- perlu bootstrap
        if "mv " in cmd and "&&" in cmd:
            return ("BOOTSTRAP_OK\n", "", 0)
        raise AssertionError(cmd)
    previous, was_bootstrap = bootstrap_or_switch(runner, None, "/var/www/bric", "/var/www/bric-releases/20260805_120000")
    assert_true(was_bootstrap)
    assert_true("bootstrap_original" in previous)
test("bootstrap_or_switch: pertama kali (masih direktori asli) -> bootstrap ke pola symlink", _t_bootstrap_first_time)

def _t_switch_already_symlink():
    def runner(client, cmd, timeout=60):
        if cmd.startswith("[ -L"):
            return ("YES\n", "", 0)
        if cmd.startswith("readlink"):
            return ("/var/www/bric-releases/20260804_090000\n", "", 0)
        if "mv -T" in cmd:
            return ("SWITCH_OK\n", "", 0)
        raise AssertionError(cmd)
    previous, was_bootstrap = bootstrap_or_switch(runner, None, "/var/www/bric", "/var/www/bric-releases/20260805_120000")
    assert_false(was_bootstrap)
    assert_eq(previous, "/var/www/bric-releases/20260804_090000")
test("bootstrap_or_switch: sudah symlink -> atomic re-point, kembalikan target lama utk rollback", _t_switch_already_symlink)

def _t_prune_keeps_current_and_recent():
    def runner(client, cmd, timeout=60):
        if cmd.startswith("readlink"):
            return ("/var/www/bric-releases/20260801_000000\n", "", 0)  # release TERLAMA sengaja masih "current" utk tes edge-case
        if cmd.startswith("ls -1"):
            return (
                "20260801_000000\n20260802_000000\n20260803_000000\n"
                "20260804_000000\n20260805_000000\n20260806_000000\n", "", 0
            )
        if cmd.startswith("rm -rf"):
            return ("", "", 0)
        raise AssertionError(cmd)
    msg = prune_old_releases(runner, None, "/var/www/bric", keep=3)
    assert_true("Dihapus" in msg)
test("prune_old_releases: rilis yg SEDANG live tidak pernah dihapus walau bukan termasuk N terbaru", _t_prune_keeps_current_and_recent)

def _t_checksum_consistent():
    import tempfile
    fd, path = tempfile.mkstemp(suffix="_bric_test_checksum.txt")
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write("halo dunia")
        import os as _os
        _os.close(fd)
        assert_eq(compute_local_sha256(path), compute_local_sha256(path))
    finally:
        Path(path).unlink(missing_ok=True)
test("compute_local_sha256: konsisten utk isi yang sama", _t_checksum_consistent)


# ── start_build / _try_recover_running_build (bug nyata 2026-08-05/06: exec_command
# start_build sendiri timeout -- build bisa saja SUDAH jalan di server tanpa
# termonitor. Fix: coba pulihkan dulu sebelum menyerah/retry membabi buta.) ──
def _t_start_build_normal():
    def runner(client, cmd, timeout=60):
        if "command -v ionice" in cmd:
            return ("YES\n", "", 0)
        if "setsid bash -c" in cmd:
            return ("PGID:12345\n", "", 0)
        raise AssertionError(cmd)
    pgid, logfile = start_build(runner, None, "/home/admin/bric-dashboard/frontend", "20260806_100000")
    assert_eq(pgid, 12345)
test("start_build: jalur normal -> PGID diambil dari output", _t_start_build_normal)

def _t_start_build_exception_then_recovered():
    calls = {"n": 0}
    def runner(client, cmd, timeout=60):
        if "command -v ionice" in cmd:
            return ("YES\n", "", 0)
        if "setsid bash -c" in cmd:
            raise TimeoutError("simulated PipeTimeout")
        if cmd.startswith("pgrep"):
            return ("9999\n", "", 0)
        if cmd.startswith("ps -o pgid="):
            return ("9999\n", "", 0)
        raise AssertionError(cmd)
    pgid, logfile = start_build(runner, None, "/home/admin/bric-dashboard/frontend", "20260806_100000")
    assert_eq(pgid, 9999)
test("start_build: exec_command exception TAPI build genuinely sudah jalan -> dipulihkan, BUKAN dianggap gagal", _t_start_build_exception_then_recovered)

def _t_start_build_exception_nothing_running():
    def runner(client, cmd, timeout=60):
        if "command -v ionice" in cmd:
            return ("YES\n", "", 0)
        if "setsid bash -c" in cmd:
            raise TimeoutError("simulated PipeTimeout")
        if cmd.startswith("pgrep"):
            return ("\n", "", 0)  # tidak ada proses ditemukan
        raise AssertionError(cmd)
    try:
        start_build(runner, None, "/home/admin/bric-dashboard/frontend", "20260806_100000")
        raise AssertionError("harusnya melempar RuntimeError")
    except RuntimeError as e:
        assert_true("tidak ditemukan build" in str(e))
test("start_build: exec_command exception DAN tidak ada build berjalan -> gagal jelas, bukan diam-diam kosong", _t_start_build_exception_nothing_running)


# ── Runner ──
pass_count = 0
fail_count = 0
for name, fn in tests:
    try:
        fn()
        pass_count += 1
        print(f"  ok  {name}")
    except Exception as err:  # noqa: BLE001
        fail_count += 1
        print(f"FAIL  {name}")
        print(f"      {err}")

print(f"\n{pass_count} passed, {fail_count} failed ({len(tests)} total)")
sys.exit(1 if fail_count else 0)
