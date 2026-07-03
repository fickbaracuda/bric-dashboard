"""
scripts/deploy_common.py

PART 2A — Modul bantu bersama untuk script deploy/backup yang AMAN.

Dipakai oleh:
  - scripts/backup_db.py
  - scripts/safe_deploy.py

TIDAK PERNAH menyimpan / menampilkan password atau token asli.
TIDAK hardcode credential apa pun di file ini.

Sumber credential (urutan pengecekan):
  1. File ".env.deploy" di root project (kalau ada) — file ini TIDAK ikut Git.
  2. Environment variable di komputer (kalau sudah di-set lewat cara lain).
  3. Kalau masih belum ketemu -> tanya langsung di terminal
     (password tidak akan terlihat saat diketik).
"""

import os
import sys
import getpass
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
ENV_DEPLOY_FILE = ROOT_DIR / ".env.deploy"

REQUIRED_DEPLOY_KEYS = ["VPS_HOST", "VPS_SSH_USER"]
OPTIONAL_DEPLOY_KEYS = {
    "REMOTE_PROJECT_PATH": "/home/admin/bric-dashboard",
    "REMOTE_FRONTEND_PATH": "/var/www/bric",
}


def _parse_env_file(path: Path) -> dict:
    """Baca file KEY=VALUE sederhana. Baris kosong / diawali '#' diabaikan."""
    data = {}
    if not path.exists():
        return data
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        data[key.strip()] = value.strip()
    return data


def mask(value: str) -> str:
    """Samarkan nilai rahasia supaya aman ditampilkan di log/terminal."""
    if not value:
        return "(kosong)"
    value = str(value)
    if len(value) <= 6:
        return "*" * len(value)
    return f"{value[:4]}{'*' * max(len(value) - 8, 4)}{value[-4:]}"


def get_deploy_config(interactive: bool = True) -> dict:
    """
    Kumpulkan konfigurasi koneksi ke VPS dari (berurutan):
    file .env.deploy -> environment variable -> tanya interaktif.

    TIDAK pernah mengembalikan nilai contoh/dummy sebagai default untuk
    host/user/password — kalau tidak ketemu dan interactive=False, akan
    berhenti dengan pesan jelas (dipakai untuk mode non-interaktif/otomatis).
    """
    file_values = _parse_env_file(ENV_DEPLOY_FILE)

    def resolve(key: str, prompt_label: str, secret: bool = False, default: str = None):
        val = file_values.get(key) or os.environ.get(key) or ""
        if val:
            return val
        if default:
            return default
        if not interactive:
            print(f"[STOP] '{key}' tidak ditemukan (tidak ada di .env.deploy, "
                  f"tidak ada di environment) dan mode non-interaktif aktif.")
            sys.exit(1)
        if secret:
            return getpass.getpass(f"{prompt_label}: ")
        return input(f"{prompt_label}: ").strip()

    config = {
        "VPS_HOST": resolve("VPS_HOST", "Alamat server (VPS_HOST)"),
        "VPS_SSH_USER": resolve("VPS_SSH_USER", "User SSH (VPS_SSH_USER)"),
        "VPS_SSH_PASSWORD": resolve("VPS_SSH_PASSWORD", "Password SSH (tidak akan terlihat)", secret=True),
        "REMOTE_PROJECT_PATH": resolve(
            "REMOTE_PROJECT_PATH", "Folder project di server",
            default=OPTIONAL_DEPLOY_KEYS["REMOTE_PROJECT_PATH"],
        ),
        "REMOTE_FRONTEND_PATH": resolve(
            "REMOTE_FRONTEND_PATH", "Folder frontend production di server",
            default=OPTIONAL_DEPLOY_KEYS["REMOTE_FRONTEND_PATH"],
        ),
    }
    return config


def connect_ssh(config: dict):
    """Buka koneksi SSH ke VPS. Mengembalikan objek paramiko.SSHClient."""
    import paramiko

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        config["VPS_HOST"],
        username=config["VPS_SSH_USER"],
        password=config["VPS_SSH_PASSWORD"],
        timeout=30,
    )
    return client


def run_remote(client, cmd: str, timeout: int = 60):
    """Jalankan 1 command di server, kembalikan (stdout_text, stderr_text, exit_code)."""
    _, out, err = client.exec_command(cmd, timeout=timeout)
    exit_code = out.channel.recv_exit_status()
    out_text = out.read().decode("utf-8", errors="replace")
    err_text = err.read().decode("utf-8", errors="replace")
    return out_text, err_text, exit_code
