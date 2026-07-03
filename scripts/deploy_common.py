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

# Alias SSH yang dicari di ~/.ssh/config kalau ada (lihat docs/DEPLOYMENT_SAFETY.md,
# bagian "Akses SSH tanpa password"). Kalau alias ini ditemukan DAN private key-nya
# benar-benar ada di disk, semua script yang pakai deploy_common.py (safe_deploy.py,
# backup_db.py, check_server_readonly.py, dll) otomatis pakai SSH KEY, TIDAK PERNAH
# menanyakan password lagi. Kalau tidak ditemukan, otomatis fallback ke alur lama
# (password interaktif via getpass) — jadi tetap kompatibel di komputer yang belum
# di-setup key-nya.
SSH_CONFIG_ALIAS = "bric-prod"


def _try_ssh_config_key_auth(alias: str = SSH_CONFIG_ALIAS) -> "dict | None":
    """
    Coba baca ~/.ssh/config untuk host alias tertentu. Kalau ketemu DAN file
    private key-nya ada di disk, kembalikan config siap pakai untuk koneksi
    berbasis SSH key (password TIDAK PERNAH ditanya). Kalau alias/file key
    tidak ada, return None supaya caller fallback ke alur password lama.

    TIDAK PERNAH membaca/menyimpan isi private key di sini — hanya path-nya.
    """
    ssh_config_path = Path.home() / ".ssh" / "config"
    if not ssh_config_path.exists():
        return None
    try:
        import paramiko
        cfg = paramiko.SSHConfig()
        with open(ssh_config_path, encoding="utf-8") as f:
            cfg.parse(f)
        host_conf = cfg.lookup(alias)
    except Exception:
        return None

    # paramiko.SSHConfig().lookup() SELALU mengembalikan dict (walau alias
    # tidak ada persis di file) — cek hostname eksplisit ada untuk pastikan
    # alias ini benar-benar terdaftar, bukan sekadar default kosong.
    if "hostname" not in host_conf or "identityfile" not in host_conf:
        return None

    key_path = Path(host_conf["identityfile"][0]).expanduser()
    if not key_path.exists():
        return None

    return {
        "VPS_HOST": host_conf["hostname"],
        "VPS_SSH_USER": host_conf.get("user", "root"),
        "VPS_SSH_KEY_PATH": str(key_path),
        "VPS_SSH_PASSWORD": None,  # tidak dipakai kalau lewat key auth
        "REMOTE_PROJECT_PATH": OPTIONAL_DEPLOY_KEYS["REMOTE_PROJECT_PATH"],
        "REMOTE_FRONTEND_PATH": OPTIONAL_DEPLOY_KEYS["REMOTE_FRONTEND_PATH"],
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
    1. Alias SSH key di ~/.ssh/config (kalau ada & key-nya ada) -> TIDAK ADA
       password sama sekali, langsung pakai SSH key. Lihat SSH_CONFIG_ALIAS.
    2. File .env.deploy -> environment variable -> tanya interaktif (alur
       lama, password via getpass, tetap dipertahankan untuk kompatibilitas
       di komputer yang belum setup SSH key).

    TIDAK pernah mengembalikan nilai contoh/dummy sebagai default untuk
    host/user/password — kalau tidak ketemu dan interactive=False, akan
    berhenti dengan pesan jelas (dipakai untuk mode non-interaktif/otomatis).
    """
    key_auth_config = _try_ssh_config_key_auth()
    if key_auth_config:
        print(f"[INFO] Memakai SSH key dari alias '{SSH_CONFIG_ALIAS}' (~/.ssh/config) — password tidak diperlukan.")
        return key_auth_config

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
    """
    Buka koneksi SSH ke VPS. Mengembalikan objek paramiko.SSHClient.

    Pakai SSH key kalau config-nya berasal dari alias ~/.ssh/config (lihat
    _try_ssh_config_key_auth) — password TIDAK PERNAH dikirim dalam kasus
    ini. Kalau tidak, fallback ke password seperti alur lama.
    """
    import paramiko

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    if config.get("VPS_SSH_KEY_PATH"):
        client.connect(
            config["VPS_HOST"],
            username=config["VPS_SSH_USER"],
            key_filename=config["VPS_SSH_KEY_PATH"],
            timeout=30,
        )
    else:
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
