import paramiko, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("147.139.201.43", username="root", password="&wi6mm!_CuzMaS,", timeout=30)

_, out, _ = client.exec_command(
    "curl -s -w '\\nHTTP:%{http_code}' -X POST https://bmsretail.my.id/api/warroom/dm-fastpay/sync "
    "-H 'Content-Type: application/json' "
    "-d '{\"token\":\"bric2026bimasaktisecret\",\"tanggal\":\"2026-06-12\",\"data\":{}}'",
    timeout=20
)
print(out.read().decode('utf-8', errors='replace'))
client.close()
