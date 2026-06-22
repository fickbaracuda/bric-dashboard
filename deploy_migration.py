import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("147.139.201.43", username="root", password="&wi6mm!_CuzMaS,", timeout=30)
def run(cmd, label="", timeout=60):
    if label: print(f"\n>>> {label}")
    _, out, err = c.exec_command(cmd, timeout=timeout)
    o = out.read().decode('utf-8', errors='replace')
    if o: print(o.strip())
run("cd /home/admin/bric-dashboard && git pull origin master 2>&1 | tail -3", "Git Pull")
run("pkill -9 -f 'node.*app.js' 2>/dev/null; sleep 1; cd /home/admin/bric-dashboard/backend && nohup node src/app.js > /var/log/bric-backend.log 2>&1 & sleep 3 && curl -s http://localhost:3001/health", "Restart")
c.close()
print("\n=== Done ===")
