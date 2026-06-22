import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("147.139.201.43", username="root", password="&wi6mm!_CuzMaS,", timeout=30)

def run(cmd, label=""):
    if label: print(f"\n>>> {label}")
    _, out, err = client.exec_command(cmd, timeout=30)
    o = out.read().decode('utf-8', errors='replace')
    e = err.read().decode('utf-8', errors='replace')
    if o: print(o)
    if e: print("[stderr]", e)

# Gunakan Python di server untuk replace string
patch_script = """
path = '/etc/nginx/sites-enabled/bric'
with open(path, 'r') as f:
    content = f.read()

old = '(segmen|speedcash|ekspedisi|fastpay|farming|pa-produk|pa-arpu|mgm)/sync'
new = '(segmen|speedcash|ekspedisi|fastpay|farming|pa-produk|pa-arpu|mgm|dm-fastpay)/sync'

if old in content:
    content = content.replace(old, new)
    with open(path, 'w') as f:
        f.write(content)
    print('Patched OK')
else:
    print('Pattern not found — cek manual')
"""

run(f'python3 -c "{patch_script}"', "Patch nginx via Python")
run("grep 'sync' /etc/nginx/sites-enabled/bric", "Verify")
run("nginx -t 2>&1", "nginx -t")
run("nginx -s reload && echo 'Nginx reloaded OK'", "nginx reload")

# Test endpoint langsung dari VPS
run("curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3001/api/warroom/dm-fastpay/sync -H 'Content-Type: application/json' -d '{\"token\":\"bric2026bimasaktisecret\",\"tanggal\":\"2026-06-12\",\"data\":{}}'", "Test backend direct")

client.close()
