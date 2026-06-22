import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("147.139.201.43", username="root", password="&wi6mm!_CuzMaS,", timeout=30)

def run(cmd):
    _, out, err = client.exec_command(cmd, timeout=15)
    print(out.read().decode('utf-8', errors='replace'))
    e = err.read().decode('utf-8', errors='replace')
    if e: print("[stderr]", e)

run("cat /etc/nginx/sites-enabled/bric")
client.close()
