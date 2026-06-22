import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("147.139.201.43", username="root", password="&wi6mm!_CuzMaS,", timeout=30)

_, out, _ = client.exec_command("curl -s http://localhost:3001/health && echo '' && ps aux | grep 'node.*app.js' | grep -v grep", timeout=15)
print(out.read().decode('utf-8', errors='replace'))
client.close()
