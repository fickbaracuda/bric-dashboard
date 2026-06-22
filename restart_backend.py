import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("147.139.201.43", username="root", password="&wi6mm!_CuzMaS,", timeout=30)

def run(cmd, label=""):
    if label: print(f"\n>>> {label}")
    _, out, err = client.exec_command(cmd, timeout=120)
    o = out.read().decode('utf-8', errors='replace')
    e = err.read().decode('utf-8', errors='replace')
    if o: print(o)
    if e: print("[stderr]", e)

run("cd /home/admin/bric-dashboard && git pull origin master 2>&1", "Git Pull")
run("pkill -f 'node.*app.js' 2>/dev/null; sleep 1; cd /home/admin/bric-dashboard/backend && nohup node src/app.js > /var/log/bric-backend.log 2>&1 & sleep 2 && curl -s http://localhost:3001/health", "Restart Backend")

client.close()
print("\nDone.")
