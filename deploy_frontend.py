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
    if o: print(o)
    if e and 'warning' not in e.lower() and 'deprecated' not in e.lower() and 'notice' not in e.lower():
        print("[err]", e[:300])

run("cd /home/admin/bric-dashboard && git pull origin master 2>&1", "Git Pull")
run("cd /home/admin/bric-dashboard/frontend && npm run build 2>&1 | tail -6", "npm build")
run("cp -r /home/admin/bric-dashboard/frontend/dist/* /var/www/bric/ && echo 'Copy OK'", "Copy dist")

c.close()
print("\n=== Deploy frontend selesai ===")
