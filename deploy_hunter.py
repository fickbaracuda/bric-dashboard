import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("147.139.201.43", username="root", password="&wi6mm!_CuzMaS,", timeout=30)

def run(cmd, label, timeout=180):
    print(f"\n>>> {label}")
    _, out, err = c.exec_command(cmd, timeout=timeout)
    o = out.read().decode('utf-8', errors='replace')
    e = err.read().decode('utf-8', errors='replace')
    if o: print(o.strip())
    if e and not any(w in e.lower() for w in ['warning','deprecated','notice','already exists']):
        print("[err]", e[:400])

# 1. Git pull
run("cd /home/admin/bric-dashboard && git pull origin master 2>&1", "Git Pull")

# 2. Migration — buat 3 tabel hunter (pakai file SQL dari repo)
run(
    "psql -U bricuser -d bricdb -f /home/admin/bric-dashboard/backend/migrations/hunter_tables.sql 2>&1",
    "Migration hunter tables"
)

# 3. Build frontend
run("cd /home/admin/bric-dashboard/frontend && npm run build 2>&1 | tail -8", "npm build", timeout=300)

# 4. Copy dist
run("cp -r /home/admin/bric-dashboard/frontend/dist/* /var/www/bric/ && echo 'Copy OK'", "Copy dist")

# 5. Restart backend
run(
    "pkill -9 -f 'node.*app.js' 2>/dev/null; sleep 1; "
    "cd /home/admin/bric-dashboard/backend && "
    "nohup node src/app.js > /var/log/bric-backend.log 2>&1 & sleep 3 && "
    "curl -s http://localhost:3001/health",
    "Restart backend"
)

c.close()
print("\n=== Deploy Hunter selesai ===")
