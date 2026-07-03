#!/usr/bin/env node
/**
 * backend/scripts/preflight-check.js
 *
 * PART 2A/2B — Pengecekan "sebelum deploy" (preflight check).
 *
 * TUJUAN (bahasa sederhana):
 *   Sebelum kita mengirim update ke server production, script ini
 *   mengecek beberapa hal dasar dulu, supaya ketahuan masalahnya
 *   SEBELUM dashboard ikut kena dampak — bukan sesudah.
 *
 * SIFAT SCRIPT INI: SELALU READ-ONLY / DRY-RUN.
 *   Script ini TIDAK PERNAH mengubah file apa pun, TIDAK PERNAH reload
 *   PM2, TIDAK PERNAH menjalankan migration database, TIDAK PERNAH
 *   menyentuh /var/www/bric/. Tidak ada mode lain selain "cek & lapor".
 *   Flag --dry-run boleh ditambahkan untuk kejelasan saja (perilakunya
 *   sama saja dengan tanpa flag itu).
 *
 * Cara pakai (dari komputer mana pun / dari server, tinggal jalankan Node):
 *   node backend/scripts/preflight-check.js
 *   node backend/scripts/preflight-check.js --dry-run     (sama saja, ditulis eksplisit)
 *   node backend/scripts/preflight-check.js --production  (mode ketat, untuk sebelum deploy production)
 *
 * Semua nilai rahasia (password/token) di laporan ini SELALU disamarkan
 * (masking) — tidak pernah ditampilkan lengkap di layar/log.
 *
 * STATUS AKHIR: salah satu dari PASS / WARNING / FAIL.
 *   PASS    -> semua aman, boleh lanjut.
 *   WARNING -> ada hal yang sebaiknya dibereskan, tapi tidak menghalangi.
 *   FAIL    -> ada masalah yang WAJIB dibereskan dulu. Jangan lanjut deploy.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Muat file backend/.env kalau ada, supaya proses ini bisa "melihat" environment
// variable yang sama seperti yang dipakai backend sungguhan.
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {
  // dotenv tidak wajib tersedia untuk script ini bisa jalan; kalau gagal, lanjut saja
  // dan preflight akan melaporkan env variable yang memang tidak ketemu.
}

const { maskSecret } = require('../src/config/env');

const isProdMode = process.argv.includes('--production');

const REQUIRED_ENV = [
  'DATABASE_URL',
  'JWT_SECRET',
  'ADMIN_PASSWORD',
  'VIEWER_PASSWORD',
  'APPS_SCRIPT_TOKEN',
  'MGM_PA_SYNC_TOKEN',
];

const RECOMMENDED_ENV = [
  'PORT',
  'ALLOWED_ORIGIN',
  'GEMINI_API_KEY',
];

// Endpoint health-check resmi yang HARUS dipakai oleh script deploy mana pun.
const EXPECTED_HEALTH_URL = 'http://localhost:3001/health';

// Perintah PM2 resmi yang HARUS dipakai untuk restart backend production.
const EXPECTED_PM2_COMMAND = 'sudo -u admin pm2 reload bric-backend';

// Pola yang TIDAK BOLEH ada di script deploy baru.
const FORBIDDEN_PATTERNS = [
  { label: 'pkill (mematikan proses secara paksa)', regex: /pkill/i },
  { label: 'menjalankan backend manual via nohup sebagai root', regex: /nohup\s+node/i },
];

/**
 * Buang bagian yang BUKAN kode yang benar-benar dieksekusi, supaya
 * FORBIDDEN_PATTERNS tidak salah tangkap kalimat seperti
 * "TIDAK PERNAH memakai pkill" (yang justru MELARANG, bukan memakai)
 * di dalam docstring / komentar / print().
 *
 * Yang dibuang: docstring modul Python di awal file ("""..."""),
 * baris komentar Python (diawali '#'), dan baris yang berisi print(...).
 * Ini heuristik sederhana (bukan parser penuh), tapi cukup untuk
 * membedakan "kalimat yang menyebut nama perintah terlarang" vs
 * "kode yang benar-benar memanggil perintah itu".
 */
function extractExecutableCode(content) {
  let code = content.replace(/^"""[\s\S]*?"""\s*/, '');
  code = code
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) return false;
      if (trimmed.includes('print(')) return false;
      return true;
    })
    .join('\n');
  return code;
}

// File "safety tooling" baru yang lahir dari Part 2A — ini yang wajib bersih
// dari pola berbahaya & credential hardcoded baru. (Kode lama/legacy yang
// sudah ditandai deprecated TIDAK dicek ulang di sini — itu urusan Part 2B/2C,
// sudah didaftarkan terpisah di docs/DEPLOYMENT_SAFETY.md.)
const ROOT = path.join(__dirname, '..', '..');
const NEW_SAFETY_FILES = [
  path.join(ROOT, 'scripts', 'safe_deploy.py'),
  path.join(ROOT, 'scripts', 'backup_db.py'),
  path.join(ROOT, 'scripts', 'deploy_common.py'),
  path.join(ROOT, 'scripts', 'check_server_readonly.py'),
  path.join(ROOT, 'backend', 'scripts', 'preflight-check.js'),
  path.join(ROOT, 'backend', 'src', 'config', 'env.js'),
];

const HARDCODED_SECRET_PATTERNS = [
  { label: 'password tertulis langsung dalam tanda kutip', regex: /password\s*=\s*["'][^"'$)]{4,}["']/i },
  { label: 'sync token BRIC versi lama tertulis langsung (bukan lewat env)', regex: /['"]bric2026(bimasaktisecret|mgmpasecret)['"]/ },
];

// ── Kumpulkan semua temuan sebagai daftar {level, text}, level: 'ok'|'warning'|'fail'|'info'
const findings = [];
function record(level, text) {
  findings.push({ level, text });
}

const lines = [];
function say(line) {
  lines.push(line);
}

say('==============================================================');
say('  BRIC DASHBOARD — PREFLIGHT CHECK (Part 2A/2B)');
say(`  Mode      : ${isProdMode ? 'PRODUCTION (ketat)' : 'biasa / development'}`);
say('  Sifat     : READ-ONLY / DRY-RUN — tidak mengubah apa pun, tidak reload PM2,');
say('              tidak menjalankan migration, tidak menyentuh /var/www/bric/.');
say('==============================================================');
say('');

// ── 1. Cek environment variable wajib ──────────────────────────────────
say('1) Environment variable WAJIB:');
for (const key of REQUIRED_ENV) {
  const val = process.env[key];
  if (val) {
    say(`   [OK]      ${key} = ${maskSecret(val)}`);
    record('ok', `${key} tersedia`);
  } else {
    say(`   [HILANG]  ${key} = (tidak ditemukan)`);
    if (isProdMode) {
      record('fail', `${key} wajib ada di mode production tapi tidak ditemukan`);
    } else {
      record('warning', `${key} belum di-set (mode biasa, belum wajib, tapi perlu dibereskan sebelum production)`);
    }
  }
}

say('');
say('2) Environment variable disarankan (opsional, tidak wajib):');
for (const key of RECOMMENDED_ENV) {
  const val = process.env[key];
  if (val) {
    say(`   [OK]      ${key} = ${maskSecret(val)}`);
    record('ok', `${key} tersedia`);
  } else {
    say(`   [kosong]  ${key} = (tidak diisi)`);
    record('warning', `${key} tidak diisi (opsional, tapi disarankan dicek)`);
  }
}

// ── 2. Cek isi script deploy baru (kalau sudah ada) ────────────────────
say('');
say('3) Cek script deploy baru (safe_deploy.py) — perintah restart & larangan:');
const safeDeployPath = path.join(ROOT, 'scripts', 'safe_deploy.py');
if (fs.existsSync(safeDeployPath)) {
  const content = fs.readFileSync(safeDeployPath, 'utf8');

  if (content.includes(EXPECTED_PM2_COMMAND)) {
    say(`   [OK]      Menemukan perintah PM2 yang benar: "${EXPECTED_PM2_COMMAND}"`);
    record('ok', 'safe_deploy.py memakai perintah PM2 resmi');
  } else {
    say(`   [HILANG]  Tidak menemukan perintah PM2 resmi "${EXPECTED_PM2_COMMAND}" di safe_deploy.py`);
    record('fail', 'safe_deploy.py tidak memakai perintah PM2 resmi');
  }

  const executableContent = extractExecutableCode(content);
  let foundForbidden = false;
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.regex.test(executableContent)) {
      say(`   [BAHAYA]  Ditemukan pola terlarang di safe_deploy.py: ${pattern.label}`);
      record('fail', `safe_deploy.py mengandung pola terlarang: ${pattern.label}`);
      foundForbidden = true;
    }
  }
  if (!foundForbidden) {
    say('   [OK]      Tidak ditemukan pola pkill / nohup manual di safe_deploy.py (di luar komentar/docstring/print)');
    record('ok', 'safe_deploy.py bersih dari pkill/nohup manual');
  }
} else {
  say('   [info]    scripts/safe_deploy.py belum ada di komputer ini — dilewati.');
  record('warning', 'scripts/safe_deploy.py tidak ditemukan saat preflight dijalankan');
}

// ── 3. Cek credential hardcoded di file "safety tooling" baru ──────────
say('');
say('4) Cek credential hardcoded di file keamanan baru (Part 2A/2B):');
for (const filePath of NEW_SAFETY_FILES) {
  const relPath = path.relative(ROOT, filePath);
  if (!fs.existsSync(filePath)) {
    say(`   [info]    ${relPath} belum ada — dilewati.`);
    continue;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  let fileHasIssue = false;
  for (const pattern of HARDCODED_SECRET_PATTERNS) {
    if (pattern.regex.test(content)) {
      say(`   [BAHAYA]  ${relPath}: terindikasi ${pattern.label}`);
      record('fail', `${relPath}: ${pattern.label}`);
      fileHasIssue = true;
    }
  }
  if (!fileHasIssue) {
    say(`   [OK]      ${relPath} bersih dari pola credential hardcoded yang dicek.`);
    record('ok', `${relPath} bersih`);
  }
}

// ── 4. Info referensi (bukan pengecekan aktif, sekedar dicatat) ────────
say('');
say('5) Referensi konfigurasi resmi (dicatat, bukan pengecekan aktif):');
say(`   Health check URL : ${EXPECTED_HEALTH_URL}`);
say('   Folder build frontend yang diharapkan ada SETELAH build: frontend/dist');
say('   (Cek folder ini dilakukan oleh safe_deploy.py tepat sesudah langkah build,');
say('    bukan di sini, karena sebelum build folder ini memang belum ada.)');

// ── Tentukan status akhir: FAIL > WARNING > PASS ───────────────────────
const hasFail = findings.some((f) => f.level === 'fail');
const hasWarning = findings.some((f) => f.level === 'warning');
const finalStatus = hasFail ? 'FAIL' : hasWarning ? 'WARNING' : 'PASS';

say('');
say('==============================================================');
say(`  STATUS AKHIR: ${finalStatus}`);
if (finalStatus === 'FAIL') {
  say('  Ada hal yang WAJIB diperbaiki dulu. JANGAN lanjut ke deploy.');
} else if (finalStatus === 'WARNING') {
  say('  Tidak ada yang menghalangi total, tapi ada beberapa hal yang sebaiknya');
  say('  dibereskan sebelum ini benar-benar dipakai untuk production.');
} else {
  say('  Semua pengecekan lolos. Aman untuk lanjut ke tahap berikutnya.');
}
say('==============================================================');

console.log(lines.join('\n'));

// Exit code: 0 untuk PASS/WARNING (tidak menghalangi otomatisasi lain),
// 1 HANYA untuk FAIL (dipakai safe_deploy.py untuk berhenti total).
process.exit(finalStatus === 'FAIL' ? 1 : 0);
