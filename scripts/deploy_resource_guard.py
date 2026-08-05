"""
scripts/deploy_resource_guard.py

Resource preflight gate untuk safe_deploy.py — audit CPU-saturation
(2026-08-05) menemukan bahwa `npm run build` dijalankan LANGSUNG di VPS
tanpa pengecekan resource apa pun, di server dengan spesifikasi SANGAT
terbatas:

    VPS aktual (dicek read-only sebelum menulis modul ini):
      - 2 vCPU
      - 1.6 GB RAM total, ~324 MB available saat idle
      - 0 swap (tidak ada buffer sama sekali)
      - bric-backend (Node) sendiri sudah pakai ~750 MB RSS (45% RAM) saat idle

Build frontend (Vite/esbuild/rollup, bundle ~1.9MB) di server sekecil ini
bisa memenuhi 100% CPU di kedua core DAN mendekati/melebihi RAM yang
tersisa -- karena tidak ada swap, itu bisa memicu OOM-killer yang justru
menyasar proses Node backend (proses RSS terbesar di server).

Modul ini SENGAJA dipisah dari safe_deploy.py supaya logic keputusan
(evaluate_resource_gate, parser-parser di bawah) bisa dites tanpa koneksi
SSH sungguhan -- lihat scripts/test_deploy_hardening.py.

TIDAK PERNAH menulis/mengubah apa pun di server -- modul ini murni baca.
"""

import re

# ── Threshold (conservative, didokumentasikan alasannya di
# docs/DEPLOYMENT_SAFETY.md) -- semua bisa di-override lewat parameter
# DeployThresholds kalau suatu saat VPS di-upgrade spesifikasinya. ──
DEFAULT_THRESHOLDS = {
    # CPU load average 1 menit tidak boleh melebihi (cpu_count * faktor ini)
    # sebelum memulai build. 0.7 dipilih supaya masih ada headroom nyata
    # (di server 2-core, itu load 1.4) -- BUKAN menunggu sampai literally
    # 100% baru berhenti, karena build sendiri akan menambah beban lagi.
    "MAX_LOAD1_PER_CPU": 0.7,
    # RAM tersedia (kolom "available" dari `free -m`, BUKAN "free" mentah --
    # available sudah memperhitungkan buff/cache yang bisa direclaim) minimal
    # dalam MB. Di server tanpa swap, ini garis pertahanan TERAKHIR sebelum
    # OOM-killer beraksi -- dipilih konservatif (250MB) krn baseline available
    # saat idle di VPS produksi cuma ~324MB; build butuh ruang utk tumbuh.
    "MIN_AVAILABLE_RAM_MB": 250,
    # Swap yang TERPAKAI (bukan total) -- kalau server MULAI swapping sama
    # sekali, itu tanda RAM sudah mepet, STOP walau CPU/load masih terlihat OK
    # (proses yang di-swap out justru bikin load MISLEADING rendah).
    "MAX_SWAP_USED_MB": 50,
    # Disk root minimal tersisa (GB) -- backup frontend + release baru +
    # pg_dump semua butuh ruang; kalau disk penuh, PostgreSQL/backup/build
    # bisa gagal dgn cara yang membingungkan (bukan error yang jelas).
    "MIN_DISK_FREE_GB": 3,
    # Jumlah query PostgreSQL yang sudah aktif > N detik -- proxy kasar utk
    # "server sedang berat" (termasuk kemungkinan sync/import besar sedang
    # berjalan, spec bagian K "sync-aware safety" -- tidak invent deteksi
    # sync yang rapuh, cukup pakai sinyal aktivitas DB yang sudah ada).
    "MAX_LONG_RUNNING_QUERIES": 3,
    "LONG_RUNNING_QUERY_SECONDS": 30,
}

# Selama build berjalan, threshold ABORT lebih longgar dari threshold START
# (build SENDIRI akan menaikkan CPU -- itu bukan alasan membatalkan kalau
# masih dalam batas wajar). ABORT hanya kalau kondisi kritis BERKEPANJANGAN.
BUILD_MONITOR_DEFAULTS = {
    "POLL_INTERVAL_SECONDS": 5,
    # CPU load1/cpu_count di atas ini selama build dianggap "kritis".
    "CRITICAL_LOAD1_PER_CPU": 1.6,
    # RAM available di bawah ini selama build dianggap "kritis" (lebih ketat
    # dari start-gate krn tanpa swap, kehabisan RAM = OOM-killer, bukan slow).
    "CRITICAL_MIN_AVAILABLE_RAM_MB": 100,
    # Berapa kali BERTURUT-TURUT (tiap POLL_INTERVAL_SECONDS) kondisi kritis
    # harus terdeteksi sebelum build di-abort -- supaya lonjakan sesaat
    # (mis. minifier lagi kerja keras sebentar) tidak langsung membatalkan
    # build yang sebenarnya akan selesai normal. 3x5s = 15 detik sustained.
    "SUSTAINED_BREACHES_TO_ABORT": 3,
    "MAX_BUILD_SECONDS": 480,
}


def parse_free_output(text: str) -> dict:
    """Parse output `free -m` (kolom: total used free shared buff/cache available)."""
    mem = {"total_mb": None, "available_mb": None}
    swap = {"total_mb": None, "used_mb": None}
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0].startswith("Mem"):
            # Mem: total used free shared buff/cache available
            if len(parts) >= 7:
                mem["total_mb"] = int(parts[1])
                mem["available_mb"] = int(parts[6])
        elif parts[0].startswith("Swap"):
            if len(parts) >= 3:
                swap["total_mb"] = int(parts[1])
                swap["used_mb"] = int(parts[2])
    return {"mem": mem, "swap": swap}


def parse_uptime_loadavg(text: str) -> dict:
    """Parse output `uptime` -> {load1, load5, load15}. None kalau gagal parse."""
    m = re.search(r"load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)", text)
    if not m:
        return {"load1": None, "load5": None, "load15": None}
    return {"load1": float(m.group(1)), "load5": float(m.group(2)), "load15": float(m.group(3))}


def parse_df_output(text: str) -> dict:
    """Parse baris kedua output `df -h /` (atau df -BG /) -> {avail_gb}. Pakai df -BG supaya satuan pasti GB."""
    lines = [l for l in text.splitlines() if l.strip()]
    if len(lines) < 2:
        return {"avail_gb": None}
    parts = lines[1].split()
    if len(parts) < 4:
        return {"avail_gb": None}
    avail_raw = parts[3].rstrip("G")
    try:
        return {"avail_gb": float(avail_raw)}
    except ValueError:
        return {"avail_gb": None}


def evaluate_resource_gate(snapshot: dict, thresholds: dict = None) -> "tuple[bool, list[str]]":
    """
    PURE — tidak menyentuh SSH/network. Terima snapshot (dict, lihat
    fetch_resource_snapshot) + threshold, kembalikan (aman_utk_deploy, alasan[]).

    Fail-closed: field yang tidak bisa dibaca (None) dianggap TIDAK AMAN
    (lebih baik menunda deploy daripada deploy buta tanpa tahu kondisi server).
    """
    t = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    reasons = []

    cpu_count = snapshot.get("cpu_count")
    load1 = snapshot.get("load1")
    if cpu_count is None or load1 is None:
        reasons.append("Tidak bisa membaca CPU count / load average server -- fail-closed, tunda deploy.")
    else:
        max_load = t["MAX_LOAD1_PER_CPU"] * cpu_count
        if load1 >= max_load:
            reasons.append(f"Load average 1 menit ({load1}) >= ambang batas ({max_load:.2f} = {t['MAX_LOAD1_PER_CPU']}x{cpu_count} core).")

    avail_ram = snapshot.get("available_ram_mb")
    if avail_ram is None:
        reasons.append("Tidak bisa membaca RAM available server -- fail-closed, tunda deploy.")
    elif avail_ram < t["MIN_AVAILABLE_RAM_MB"]:
        reasons.append(f"RAM available ({avail_ram}MB) di bawah ambang batas ({t['MIN_AVAILABLE_RAM_MB']}MB).")

    swap_used = snapshot.get("swap_used_mb")
    if swap_used is not None and swap_used > t["MAX_SWAP_USED_MB"]:
        reasons.append(f"Swap terpakai ({swap_used}MB) melebihi ambang batas ({t['MAX_SWAP_USED_MB']}MB) -- indikasi RAM sudah mepet.")

    disk_free = snapshot.get("disk_free_gb")
    if disk_free is None:
        reasons.append("Tidak bisa membaca disk free server -- fail-closed, tunda deploy.")
    elif disk_free < t["MIN_DISK_FREE_GB"]:
        reasons.append(f"Disk tersisa ({disk_free}GB) di bawah ambang batas ({t['MIN_DISK_FREE_GB']}GB).")

    if snapshot.get("backend_healthy") is False:
        reasons.append("Backend TIDAK sehat (/health gagal) SEBELUM deploy dimulai -- ini bukan disebabkan deploy, tapi deploy tidak boleh menambah beban ke server yang sudah bermasalah.")

    if snapshot.get("pm2_online") is False:
        reasons.append("PM2 melaporkan bric-backend TIDAK online.")

    long_queries = snapshot.get("long_running_queries")
    if long_queries is not None and long_queries > t["MAX_LONG_RUNNING_QUERIES"]:
        reasons.append(
            f"{long_queries} query PostgreSQL aktif > {t['LONG_RUNNING_QUERY_SECONDS']}s "
            f"(ambang batas {t['MAX_LONG_RUNNING_QUERIES']}) -- kemungkinan sync/import besar sedang berjalan."
        )

    return (len(reasons) == 0, reasons)


def fetch_resource_snapshot(run_remote_fn, client, remote_project: str) -> dict:
    """
    Kumpulkan snapshot resource server via SSH (read-only murni: nproc, free,
    uptime, df, pm2 jlist, curl /health, psql read-only count query).
    `run_remote_fn` diinjeksi (bukan import langsung) supaya fungsi ini bisa
    dites dengan fake runner tanpa SSH sungguhan kalau perlu.
    """
    snapshot = {}

    out, _, code = run_remote_fn(client, "nproc")
    try:
        snapshot["cpu_count"] = int(out.strip()) if code == 0 else None
    except ValueError:
        snapshot["cpu_count"] = None

    out, _, code = run_remote_fn(client, "free -m")
    parsed = parse_free_output(out) if code == 0 else {"mem": {}, "swap": {}}
    snapshot["available_ram_mb"] = parsed["mem"].get("available_mb")
    snapshot["total_ram_mb"] = parsed["mem"].get("total_mb")
    snapshot["swap_used_mb"] = parsed["swap"].get("used_mb")

    out, _, code = run_remote_fn(client, "uptime")
    loadavg = parse_uptime_loadavg(out) if code == 0 else {"load1": None}
    snapshot["load1"] = loadavg.get("load1")
    snapshot["load5"] = loadavg.get("load5")

    out, _, code = run_remote_fn(client, "df -BG /")
    df_parsed = parse_df_output(out) if code == 0 else {"avail_gb": None}
    snapshot["disk_free_gb"] = df_parsed.get("avail_gb")

    out, _, code = run_remote_fn(client, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/health")
    snapshot["backend_healthy"] = (out.strip() == "200")

    out, _, code = run_remote_fn(client, "sudo -u admin pm2 jlist 2>/dev/null")
    pm2_online = None
    try:
        import json
        data = json.loads(out)
        for proc in data:
            if proc.get("name") == "bric-backend":
                pm2_online = proc.get("pm2_env", {}).get("status") == "online"
    except Exception:
        pm2_online = None
    snapshot["pm2_online"] = pm2_online

    # PostgreSQL: query aktif > N detik -- opsional, gagal senyap kalau
    # DATABASE_URL/psql tidak tersedia (bukan blocker preflight secara mutlak,
    # tapi field None akan bikin evaluate_resource_gate skip check ini, bukan
    # fail-closed -- ini BEDA dari CPU/RAM/disk krn ini sinyal TAMBAHAN, bukan
    # sinyal inti kesehatan server).
    check_cmd = (
        f"cd {remote_project} && "
        "if [ -f backend/.env ] && grep -q '^DATABASE_URL=' backend/.env; then "
        "set -a && source backend/.env && set +a && "
        "psql \"$DATABASE_URL\" -t -A -c "
        "\"SELECT COUNT(*) FROM pg_stat_activity WHERE state='active' AND query_start < NOW() - INTERVAL '30 seconds' AND pid != pg_backend_pid()\" "
        "2>/dev/null; fi"
    )
    out, _, code = run_remote_fn(client, check_cmd, timeout=20)
    try:
        snapshot["long_running_queries"] = int(out.strip()) if out.strip().isdigit() else None
    except Exception:
        snapshot["long_running_queries"] = None

    return snapshot


def format_snapshot_report(snapshot: dict) -> str:
    """Format snapshot jadi teks laporan singkat (dipakai di log/observability, tidak pernah berisi secret)."""
    lines = [
        f"CPU: {snapshot.get('cpu_count', '?')} core, load1={snapshot.get('load1', '?')}",
        f"RAM: available={snapshot.get('available_ram_mb', '?')}MB / total={snapshot.get('total_ram_mb', '?')}MB, swap_used={snapshot.get('swap_used_mb', '?')}MB",
        f"Disk free: {snapshot.get('disk_free_gb', '?')}GB",
        f"Backend healthy: {snapshot.get('backend_healthy', '?')}, PM2 online: {snapshot.get('pm2_online', '?')}",
        f"Long-running PG queries (>30s): {snapshot.get('long_running_queries', '?')}",
    ]
    return "\n".join(lines)
