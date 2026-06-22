import paramiko, sys

# Fix encoding untuk output UTF-8 di Windows
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("147.139.201.43", username="root", password="&wi6mm!_CuzMaS,", timeout=30)

def run(cmd, label=""):
    if label:
        print(f"\n>>> {label}")
    _, out, err = client.exec_command(cmd, timeout=180)
    o = out.read().decode('utf-8', errors='replace')
    e = err.read().decode('utf-8', errors='replace')
    if o: print(o)
    if e: print("[stderr]", e)

# Step 1: SQL migration via postgres superuser
sql = """CREATE TABLE IF NOT EXISTS dm_fastpay_snapshot (
  id SERIAL PRIMARY KEY,
  tanggal DATE NOT NULL,
  rev_target NUMERIC DEFAULT 0, rev_actual NUMERIC DEFAULT 0, rev_progress NUMERIC DEFAULT 0,
  nmat_target INTEGER DEFAULT 0, nmat_actual INTEGER DEFAULT 0, nmat_progress NUMERIC DEFAULT 0,
  app_google_budget NUMERIC DEFAULT 0, app_google_impression BIGINT DEFAULT 0,
  app_google_cpm NUMERIC DEFAULT 0, app_google_install INTEGER DEFAULT 0, app_google_cpi NUMERIC DEFAULT 0,
  app_tiktok_budget NUMERIC DEFAULT 0, app_tiktok_impression BIGINT DEFAULT 0,
  app_tiktok_cpm NUMERIC DEFAULT 0, app_tiktok_install INTEGER DEFAULT 0, app_tiktok_cpi NUMERIC DEFAULT 0,
  ret_google_budget NUMERIC DEFAULT 0, ret_google_impression BIGINT DEFAULT 0,
  ret_google_cpm NUMERIC DEFAULT 0, ret_google_action INTEGER DEFAULT 0, ret_google_cpa NUMERIC DEFAULT 0,
  ret_tiktok_budget NUMERIC DEFAULT 0, ret_tiktok_impression BIGINT DEFAULT 0,
  ret_tiktok_cpm NUMERIC DEFAULT 0, ret_tiktok_action INTEGER DEFAULT 0, ret_tiktok_cpa NUMERIC DEFAULT 0,
  brand_target NUMERIC DEFAULT 0, brand_actual NUMERIC DEFAULT 0, brand_progress NUMERIC DEFAULT 0,
  reg_direct INTEGER DEFAULT 0, reg_direct_cpa NUMERIC DEFAULT 0,
  akt_direct INTEGER DEFAULT 0, akt_direct_cpa NUMERIC DEFAULT 0, konversi NUMERIC DEFAULT 0,
  nmat_jawa_target INTEGER DEFAULT 0, nmat_jawa_actual INTEGER DEFAULT 0, nmat_jawa_progress NUMERIC DEFAULT 0,
  roi NUMERIC DEFAULT 0, rev_trx_direct NUMERIC DEFAULT 0,
  meta_budget NUMERIC DEFAULT 0, meta_impression BIGINT DEFAULT 0, meta_cpm NUMERIC DEFAULT 0,
  meta_klik INTEGER DEFAULT 0, meta_hasil BIGINT DEFAULT 0, meta_biaya_hasil NUMERIC DEFAULT 0,
  konten_official INTEGER DEFAULT 0, konten_kol INTEGER DEFAULT 0, konten_paid_ads INTEGER DEFAULT 0,
  synced_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tanggal)
);
GRANT ALL ON dm_fastpay_snapshot TO bricuser;
GRANT USAGE, SELECT ON SEQUENCE dm_fastpay_snapshot_id_seq TO bricuser;"""

run(f'sudo -u postgres psql -d bric -c "{sql}"', "SQL Migration")

# Step 2: git pull (sudah dilakukan sebelumnya tapi pastikan OK)
run("cd /home/admin/bric-dashboard && git pull origin master 2>&1", "Git Pull")

# Step 3: build frontend
run("cd /home/admin/bric-dashboard/frontend && npm run build 2>&1 | tail -10", "npm build")

# Step 4: copy dist
run("cp -r /home/admin/bric-dashboard/frontend/dist/* /var/www/bric/ && echo 'Copy OK'", "Copy dist")

# Step 5: restart backend
run("pkill -f 'node.*app.js' 2>/dev/null; sleep 1; cd /home/admin/bric-dashboard/backend && nohup node src/app.js > /var/log/bric-backend.log 2>&1 & sleep 2 && curl -s http://localhost:3001/health", "Restart Backend")

client.close()
print("\nDone.")
