import paramiko, sys, time
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("147.139.201.43", username="root", password="&wi6mm!_CuzMaS,", timeout=30)

def run(cmd, label, timeout=180):
    print(f"\n>>> {label}")
    _, out, err = c.exec_command(cmd, timeout=timeout)
    o = out.read().decode('utf-8', errors='replace')
    e = err.read().decode('utf-8', errors='replace')
    if o: print(o)
    if e and 'warning' not in e.lower() and 'deprecated' not in e.lower() and 'notice' not in e.lower():
        print("[err]", e[:300])

# Reset file yang konflik lalu git pull
run("cd /home/admin/bric-dashboard && git checkout -- backend/package.json backend/src/app.js && git pull origin master 2>&1", "Git reset + pull")
run("cd /home/admin/bric-dashboard/frontend && npm run build 2>&1 | tail -6", "npm build")
run("cp -r /home/admin/bric-dashboard/frontend/dist/* /var/www/bric/ && echo 'Copy OK'", "Copy dist")
# Restart backend agar pakai app.js versi terbaru
run("pkill -9 -f 'node.*app.js' 2>/dev/null; sleep 1; cd /home/admin/bric-dashboard/backend && nohup node src/app.js > /var/log/bric-backend.log 2>&1 &", "Restart backend")
time.sleep(3)
run("curl -s http://localhost:3001/health", "Health check")

c.close()
print("\n=== Deploy selesai ===")
