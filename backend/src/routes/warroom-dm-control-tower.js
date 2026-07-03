'use strict';

const crypto = require('crypto');
const pool = require('../db');

/**
 * DM Control Tower — pondasi backend (Prompt 1 dari 3).
 *
 * Sumber data: Google Sheet DM Control Tower, 3 sheet raw jadi source of
 * truth (analytics dihitung DI SINI dari raw data, bukan pakai formula sheet):
 *   - 03_RAW_REGISTER_DIRECT  -> dm_ct_raw_register
 *   - 04_RAW_AKTIVASI_DIRECT  -> dm_ct_raw_aktivasi
 *   - 02_RAW_TRX_DIRECT       -> dm_ct_raw_trx
 *
 * Multi-bulan: sheet yang sama dipakai terus, user replace data 3 sheet raw
 * tiap bulan lalu sync dengan bulan=YYYY-MM. Sync 1 bulan HANYA menghapus/
 * mengganti data bulan itu di tabelnya sendiri (DELETE WHERE bulan=$1 lalu
 * INSERT ulang, 1 transaksi) — bulan lain & tabel lain tidak tersentuh.
 *
 * Chunk safety (ditambahkan Prompt 2, untuk Apps Script yang mengirim rows
 * dalam banyak request karena payload besar): body sync boleh sertakan
 * `replace_mode` ('replace' | 'append'). Hanya request dengan replace_mode
 * 'replace' (atau tanpa field ini sama sekali — default, backward compatible
 * dengan pemanggilan lama non-chunk) yang menjalankan DELETE WHERE bulan=$1.
 * Request 'append' HANYA insert/upsert, tidak pernah menghapus — supaya
 * chunk terakhir tidak menghapus hasil insert chunk-chunk sebelumnya dalam
 * sync bulan yang sama. `chunk_index`/`chunk_total` opsional, dipakai hanya
 * untuk logging.
 *
 * DEFINISI 8 SEGMEN & PRIORITY P0-P3: dikonfirmasi final oleh pemilik produk
 * (lihat komentar lengkap di atas `CLASSIFIED_CTE` dan `SEGMENT_PRIORITY`).
 * Catatan: "handoff_farming" adalah metric bisnis UTAMA — outlet yang cohort-
 * nya sudah matang (lewat H3) tapi belum pernah berhasil Tx1, perlu dilempar
 * ke tim farming. Ini BUKAN segmen sehat, jangan dihitung sebagai "early
 * repeat"/sukses di ringkasan manapun.
 * Yang masih berupa inferensi saya (bukan eksplisit dari spesifikasi, mohon
 * dikonfirmasi kalau salah): penempatan `handoff_farming` di P1 dan `late_tx`
 * di P2 pada priority mapping.
 *
 * Config bulan (Prompt 3 — keputusan bisnis final): `mature_cohort_end` (dan
 * period_start/period_end) SEKARANG mengikuti tabel `dm_ct_month_config`,
 * diisi dari field yang sama di payload sync (Apps Script membacanya dari
 * sheet `01_CONFIG`). Fallback ke kalender (akhir bulan - 3 hari) HANYA
 * dipakai kalau config belum ada/field-nya kosong. Lihat `resolveMonthConfig`
 * dan `upsertMonthConfig` di bawah, serta penjelasan "kenapa ini penting
 * untuk bulan berjalan" di docs/DM_CONTROL_TOWER.md.
 */

// Part 2A/2B pattern: token WAJIB dari env, tidak ada fallback literal
// (fitur baru, tidak ada Apps Script existing yang perlu dijaga kompatibel).
const SYNC_TOKEN = process.env.APPS_SCRIPT_TOKEN;
const CHUNK = 500;

// ── Kandidat nama header (case/spasi/underscore bebas, lihat normalizeKey) ─
// PENTING (Prompt 2): daftar di bawah sempat DIPERBAIKI setelah dicek terhadap
// header ASLI Google Sheet produksi (03_RAW_REGISTER_DIRECT/04_RAW_AKTIVASI_DIRECT/
// 02_RAW_TRX_DIRECT). Sheet aktivasi pakai ejaan "tanggal_aktifasi" (bukan
// "aktivasi"), dan sheet transaksi pakai "achieve_trx"/"achieve_rev" (bukan
// "trx"/"margin") — tanpa entri ini, SEMUA baris aktivasi/transaksi akan sync
// dengan tanggal/angka NULL/0 (silent data loss). Lihat docs/DM_CONTROL_TOWER.md.
const ID_OUTLET_CANDIDATES        = ['id_outlet', 'ID Outlet', 'Outlet ID', 'id', 'Kode Outlet', 'ID Loket'];
const TANGGAL_REGISTER_CANDIDATES = ['tanggal_register', 'Tanggal Register', 'Tgl Reg', 'Tanggal Registrasi', 'tanggal_registrasi', 'created_date'];
const TANGGAL_AKTIVASI_CANDIDATES = ['tanggal_aktivasi', 'Tanggal Aktivasi', 'Tgl Aktivasi', 'tanggal_aktifasi', 'Tanggal Aktifasi', 'activation_date'];
const TANGGAL_TRANSAKSI_CANDIDATES = ['tanggal_transaksi', 'Tanggal Transaksi', 'Tgl Transaksi', 'transaction_date'];
const MARGIN_CANDIDATES     = ['margin', 'Margin', 'revenue', 'Revenue', 'rev', 'Rev', 'achieve_rev', 'Achieve Rev'];
const TRX_COUNT_CANDIDATES  = ['trx', 'Transaksi', 'jumlah_transaksi', 'Jumlah Transaksi', 'count', 'achieve_trx', 'Achieve Trx'];

// ── Row/field helpers (pola sama dengan warroom-qris-control-tower.js) ────
function normalizeKey(k) {
  return String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeRowKeys(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[normalizeKey(k)] = v;
  return out;
}

function pick(normalizedRow, ...candidateNames) {
  for (const name of candidateNames) {
    const v = normalizedRow[normalizeKey(name)];
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}

function nullIfEmpty(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Parser tanggal fleksibel. Menerima:
 *  - Date object langsung (jaga-jaga kalau pemanggil bukan lewat JSON biasa)
 *  - ISO string, dengan atau tanpa waktu ("2026-06-15" atau "2026-06-15T00:00:00.000Z")
 *    — ini juga menangkap hasil serialize Date object dari Apps Script,
 *    karena JSON.stringify(new Date()) otomatis jadi ISO string dengan waktu.
 *  - "DD/MM/YYYY"
 * @returns {string|null} "YYYY-MM-DD" atau null kalau tidak bisa di-parse/tidak valid
 */
function parseFlexibleDate(raw) {
  if (raw == null || raw === '') return null;

  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);
  }

  const s = String(raw).trim();
  if (!s) return null;

  let y, m, d;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    [, y, m, d] = iso;
  } else {
    const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dmy) {
      [, d, m, y] = dmy;
    } else {
      return null;
    }
  }

  y = Number(y); m = Number(m); d = Number(d);
  const check = new Date(y, m - 1, d);
  // Guard tanggal tidak valid (mis. 31/02/2026) — JS Date auto-rollover ke bulan berikutnya
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) return null;

  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Number parser aman — WAJIB cek typeof number DULU sebelum string processing.
 * (Insiden lama: 408146.85 diperlakukan sebagai string lalu titik desimalnya
 * kehapus jadi 40814685 — 100x lebih besar. Lihat catatan di CLAUDE.md.)
 */
function cleanNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/Rp\s*/gi, '').trim();
  if (!s) return 0;
  const neg = s.startsWith('(') && s.endsWith(')');
  const cleaned = s.replace(/[()]/g, '').replace(/,/g, '');
  const num = parseFloat(cleaned) || 0;
  return neg ? -num : num;
}

// ── row_hash — stabil terhadap urutan key (sort dulu sebelum stringify) ───
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function computeRowHash(row) {
  return crypto.createHash('md5').update(stableStringify(row)).digest('hex');
}

function isValidBulan(bulan) {
  return typeof bulan === 'string' && /^\d{4}-\d{2}$/.test(bulan);
}

/** Ambil token dari header x-sync-token, Authorization Bearer, atau body.token. */
function extractToken(req) {
  return (
    req.headers['x-sync-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    req.body?.token ||
    null
  );
}

/**
 * Batas awal/akhir bulan + "mature cohort end" (akhir bulan - 3 hari),
 * dihitung otomatis dari bulan (bukan hardcode). Contoh 2026-06 -> mature
 * end = 2026-06-27, persis sesuai contoh di spesifikasi.
 */
function getPeriodBounds(bulan) {
  const [y, m] = bulan.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const pad = (n) => String(n).padStart(2, '0');

  const periodStart = `${bulan}-01`;
  const periodEnd = `${bulan}-${pad(lastDay)}`;

  const matureDay = lastDay - 3;
  let matureCohortEnd;
  if (matureDay >= 1) {
    matureCohortEnd = `${bulan}-${pad(matureDay)}`;
  } else {
    // bulan sangat pendek (tidak realistis untuk kalender normal, jaga-jaga saja)
    const prev = new Date(y, m - 1, matureDay);
    matureCohortEnd = `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}-${pad(prev.getDate())}`;
  }

  return { periodStart, periodEnd, matureCohortEnd };
}

/**
 * Resolusi period_start/period_end/mature_cohort_end final untuk 1 bulan
 * (Prompt 3 — keputusan bisnis final).
 *
 * Source of truth: `dm_ct_month_config` (diisi dari payload sync — lihat
 * `upsertMonthConfig` — yang dikirim Apps Script dari sheet `01_CONFIG`).
 * Field ini PENTING untuk bulan BERJALAN: mature_cohort_end idealnya
 * mengikuti tanggal transaksi/data yang BENAR-BENAR sudah ada (mis. bulan
 * Juli baru berjalan sampai tgl 15 -> mature_cohort_end wajar di sekitar
 * tgl 12), BUKAN "akhir kalender bulan - 3 hari" (yang untuk bulan berjalan
 * akan salah total, misal jadi tanggal 28 padahal data baru sampai 15).
 *
 * Field diresolusi SATU PER SATU (bukan semua-atau-tidak-sama-sekali):
 * kalau config ada tapi salah satu field NULL, field itu SAJA yang jatuh ke
 * fallback kalender — field lain yang valid dari config tetap dipakai.
 */
async function resolveMonthConfig(bulan) {
  const fallback = getPeriodBounds(bulan);
  const r = await pool.query(
    'SELECT period_start, period_end, mature_cohort_end, updated_at FROM dm_ct_month_config WHERE bulan = $1',
    [bulan]
  );
  const row = r.rows[0] || null;
  // Kolom DATE dari pg driver balik sebagai JS Date (UTC midnight) —
  // toISOString().slice(0,10) aman mengembalikan tanggal kalender aslinya
  // (pola sama dengan parseFlexibleDate() di atas untuk kasus Date object).
  const toDateStr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : (d || null));

  const cfgPeriodStart = row ? toDateStr(row.period_start) : null;
  const cfgPeriodEnd = row ? toDateStr(row.period_end) : null;
  const cfgMatureCohortEnd = row ? toDateStr(row.mature_cohort_end) : null;

  const fieldsFromConfig = [cfgPeriodStart, cfgPeriodEnd, cfgMatureCohortEnd].filter(Boolean).length;
  const configSource = fieldsFromConfig === 0 ? 'fallback' : (fieldsFromConfig === 3 ? 'config' : 'partial');

  return {
    periodStart: cfgPeriodStart || fallback.periodStart,
    periodEnd: cfgPeriodEnd || fallback.periodEnd,
    matureCohortEnd: cfgMatureCohortEnd || fallback.matureCohortEnd,
    configSource,
    configUpdatedAt: row ? row.updated_at : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SYNC — token auth (bukan JWT), didaftarkan sebelum requireAuth di app.js
// ═══════════════════════════════════════════════════════════════════════

async function logSyncResult({ bulan, sourceType, received, inserted, skipped, status, errorMessage }) {
  try {
    await pool.query(
      `INSERT INTO dm_ct_sync_log
         (bulan, source_type, rows_received, rows_inserted, rows_skipped, status, error_message, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [bulan, sourceType, received || 0, inserted || 0, skipped || 0, status, errorMessage || null]
    );
  } catch (err) {
    // Jangan sampai kegagalan menulis log ikut menjatuhkan proses sync utama.
    console.error('[dm-control-tower] gagal menulis dm_ct_sync_log:', err.message);
  }
}

/**
 * Upsert `dm_ct_month_config` dari field period_start/period_end/
 * mature_cohort_end yang dikirim payload sync (Apps Script membacanya dari
 * sheet `01_CONFIG`, lihat Prompt 2 & `resolveMonthConfig` di atas).
 *
 * - Field kosong/tidak bisa di-parse disimpan sebagai NULL — TIDAK PERNAH
 *   error/menjatuhkan sync data utama (dibungkus try/catch sendiri).
 * - Upsert per-field pakai COALESCE(EXCLUDED, existing) supaya payload
 *   parsial (mis. cuma mature_cohort_end yang terisi) tidak menimpa field
 *   lain yang sudah tersimpan benar dari sync sebelumnya jadi NULL.
 * - Tidak ada value sensitif di sini (murni 3 tanggal), aman disimpan apa
 *   adanya ke `source_config` untuk audit/debug.
 */
async function upsertMonthConfig({ bulan, periodStart, periodEnd, matureCohortEnd }) {
  const ps = parseFlexibleDate(periodStart);
  const pe = parseFlexibleDate(periodEnd);
  const mce = parseFlexibleDate(matureCohortEnd);

  if (ps == null && pe == null && mce == null) return; // tidak ada config dikirim di payload ini

  const sourceConfig = JSON.stringify({
    period_start: periodStart || null,
    period_end: periodEnd || null,
    mature_cohort_end: matureCohortEnd || null,
  });

  try {
    await pool.query(
      `INSERT INTO dm_ct_month_config (bulan, period_start, period_end, mature_cohort_end, source_config, updated_at)
       VALUES ($1, $2::date, $3::date, $4::date, $5::jsonb, NOW())
       ON CONFLICT (bulan) DO UPDATE SET
         period_start      = COALESCE(EXCLUDED.period_start, dm_ct_month_config.period_start),
         period_end        = COALESCE(EXCLUDED.period_end, dm_ct_month_config.period_end),
         mature_cohort_end = COALESCE(EXCLUDED.mature_cohort_end, dm_ct_month_config.mature_cohort_end),
         source_config      = COALESCE(EXCLUDED.source_config, dm_ct_month_config.source_config),
         updated_at         = NOW()`,
      [bulan, ps, pe, mce, sourceConfig]
    );
  } catch (err) {
    // Jangan sampai kegagalan simpan config menjatuhkan sync data utama.
    console.error('[dm-control-tower] gagal upsert dm_ct_month_config:', err.message);
  }
}

/**
 * Sync register/aktivasi — 1 baris per outlet, dedup by id_outlet (baris
 * terakhir menang kalau ada id_outlet dobel dalam 1 payload), delete+insert
 * dibungkus 1 transaksi supaya tidak ada window "data bulan ini kehapus tapi
 * belum ke-insert ulang" kalau proses gagal di tengah jalan.
 */
async function syncSingleRowPerOutlet({ table, dateColumn, dateCandidates, bulan, rows, shouldDelete }) {
  const seen = new Map();
  let skipped = 0;
  for (const raw of rows) {
    const norm = normalizeRowKeys(raw);
    const idOutletRaw = pick(norm, ...ID_OUTLET_CANDIDATES);
    if (!idOutletRaw) { skipped++; continue; }
    const idOutlet = String(idOutletRaw).trim();
    const tanggal = parseFlexibleDate(pick(norm, ...dateCandidates));
    seen.set(idOutlet, { idOutlet, tanggal, rowData: raw });
  }
  const entries = [...seen.values()];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Chunk safety (Prompt 2): hanya chunk PERTAMA (replace_mode='replace')
    // yang boleh menghapus data bulan ini. Chunk berikutnya (replace_mode=
    // 'append') hanya menambah/upsert, tidak pernah menghapus — supaya chunk
    // terakhir tidak menghapus hasil insert chunk-chunk sebelumnya.
    if (shouldDelete) {
      await client.query(`DELETE FROM ${table} WHERE bulan = $1`, [bulan]);
    }

    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      await client.query(
        `INSERT INTO ${table} (bulan, id_outlet, ${dateColumn}, row_data, synced_at)
         SELECT $1, t.id_outlet, t.tanggal::date, t.row_data::jsonb, NOW()
         FROM unnest($2::text[], $3::text[], $4::text[]) AS t(id_outlet, tanggal, row_data)
         ON CONFLICT (bulan, id_outlet) DO UPDATE SET
           ${dateColumn} = EXCLUDED.${dateColumn},
           row_data      = EXCLUDED.row_data,
           synced_at     = EXCLUDED.synced_at`,
        [
          bulan,
          chunk.map(e => e.idOutlet),
          chunk.map(e => e.tanggal),
          chunk.map(e => JSON.stringify(e.rowData)),
        ]
      );
    }

    await client.query('COMMIT');
    return { received: rows.length, inserted: entries.length, skipped };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Sync transaksi — BANYAK baris per outlet (tidak dedup by id_outlet).
 * Dedup HANYA by row_hash (baris identik persis dalam 1 payload yang sama
 * tidak boleh dobel masuk 1 batch unnest yang sama, sama seperti pola dedup
 * id_outlet di file WAR-ROOM lain, tapi di sini keyed row_hash).
 */
async function syncTrxRows({ bulan, rows, shouldDelete }) {
  const seen = new Map();
  let skipped = 0;
  for (const raw of rows) {
    const norm = normalizeRowKeys(raw);
    const idOutletRaw = pick(norm, ...ID_OUTLET_CANDIDATES);
    if (!idOutletRaw) { skipped++; continue; }
    const idOutlet = String(idOutletRaw).trim();
    const tanggal = parseFlexibleDate(pick(norm, ...TANGGAL_TRANSAKSI_CANDIDATES));
    const trxCount = cleanNum(pick(norm, ...TRX_COUNT_CANDIDATES));
    const margin = cleanNum(pick(norm, ...MARGIN_CANDIDATES));
    const rowHash = computeRowHash(raw);
    seen.set(rowHash, { idOutlet, tanggal, trxCount, margin, rowHash, rowData: raw });
  }
  const entries = [...seen.values()];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Chunk safety (Prompt 2): sama seperti syncSingleRowPerOutlet — hanya
    // chunk pertama (replace_mode='replace') yang menghapus data bulan ini.
    if (shouldDelete) {
      await client.query('DELETE FROM dm_ct_raw_trx WHERE bulan = $1', [bulan]);
    }

    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      await client.query(
        `INSERT INTO dm_ct_raw_trx
           (bulan, id_outlet, tanggal_transaksi, trx_count, margin, row_hash, row_data, synced_at)
         SELECT $1, t.id_outlet, t.tanggal::date, t.trx_count::numeric, t.margin::numeric,
                t.row_hash, t.row_data::jsonb, NOW()
         FROM unnest($2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::text[], $7::text[])
           AS t(id_outlet, tanggal, trx_count, margin, row_hash, row_data)
         ON CONFLICT (bulan, row_hash) DO UPDATE SET
           id_outlet         = EXCLUDED.id_outlet,
           tanggal_transaksi = EXCLUDED.tanggal_transaksi,
           trx_count         = EXCLUDED.trx_count,
           margin            = EXCLUDED.margin,
           row_data          = EXCLUDED.row_data,
           synced_at         = EXCLUDED.synced_at`,
        [
          bulan,
          chunk.map(e => e.idOutlet),
          chunk.map(e => e.tanggal),
          chunk.map(e => e.trxCount),
          chunk.map(e => e.margin),
          chunk.map(e => e.rowHash),
          chunk.map(e => JSON.stringify(e.rowData)),
        ]
      );
    }

    await client.query('COMMIT');
    return { received: rows.length, inserted: entries.length, skipped };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Chunk safety (Prompt 2): payload boleh mengirim `replace_mode` ('replace'
 * atau 'append') + `chunk_index`/`chunk_total` (opsional, hanya untuk log).
 * Default (field tidak dikirim sama sekali) = 'replace', supaya kompatibel
 * dengan pemanggilan lama/manual 1x-request tanpa chunking (perilaku Prompt 1
 * tetap sama persis kalau tidak ada chunking).
 */
function resolveReplaceMode(body) {
  const rm = body?.replace_mode;
  if (rm === undefined || rm === null || rm === '') return 'replace';
  if (rm === 'replace' || rm === 'append') return rm;
  return null;
}

function validateSyncBody(req, res) {
  const token = extractToken(req);
  if (token !== SYNC_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const { bulan, rows } = req.body || {};
  if (!isValidBulan(bulan)) {
    res.status(400).json({ error: 'bulan wajib format YYYY-MM' });
    return null;
  }
  if (!Array.isArray(rows)) {
    res.status(400).json({ error: 'rows wajib berupa array' });
    return null;
  }
  const replaceMode = resolveReplaceMode(req.body);
  if (replaceMode === null) {
    res.status(400).json({ error: "replace_mode wajib 'replace' atau 'append' (atau dikosongkan)" });
    return null;
  }
  const rawChunkIndex = Number(req.body?.chunk_index);
  const rawChunkTotal = Number(req.body?.chunk_total);
  const chunkIndex = Number.isFinite(rawChunkIndex) && req.body?.chunk_index != null ? rawChunkIndex : null;
  const chunkTotal = Number.isFinite(rawChunkTotal) && req.body?.chunk_total != null ? rawChunkTotal : null;
  // Prompt 3: config bulan (opsional) — lihat upsertMonthConfig/resolveMonthConfig.
  const configFields = {
    periodStart: nullIfEmpty(req.body?.period_start),
    periodEnd: nullIfEmpty(req.body?.period_end),
    matureCohortEnd: nullIfEmpty(req.body?.mature_cohort_end),
  };
  return { bulan, rows, replaceMode, chunkIndex, chunkTotal, configFields };
}

async function registerSyncHandler(req, res) {
  const parsed = validateSyncBody(req, res);
  if (!parsed) return;
  const { bulan, rows, replaceMode, chunkIndex, chunkTotal, configFields } = parsed;

  await upsertMonthConfig({ bulan, ...configFields });
  res.json({ ok: true, bulan, received: rows.length, replace_mode: replaceMode, chunk_index: chunkIndex, chunk_total: chunkTotal });

  setImmediate(async () => {
    try {
      const result = await syncSingleRowPerOutlet({
        table: 'dm_ct_raw_register',
        dateColumn: 'tanggal_register',
        dateCandidates: TANGGAL_REGISTER_CANDIDATES,
        bulan, rows,
        shouldDelete: replaceMode === 'replace',
      });
      await logSyncResult({ bulan, sourceType: 'register', ...result, status: 'success' });
      console.log(`[dm-control-tower register sync] bulan ${bulan} chunk ${chunkIndex ?? '-'}/${chunkTotal ?? '-'} (${replaceMode}): ${result.inserted} outlet, ${result.skipped} dilewati (id kosong)`);
    } catch (err) {
      console.error('[dm-control-tower register sync] error:', err.message);
      await logSyncResult({ bulan, sourceType: 'register', received: rows.length, status: 'error', errorMessage: err.message });
    }
  });
}

async function aktivasiSyncHandler(req, res) {
  const parsed = validateSyncBody(req, res);
  if (!parsed) return;
  const { bulan, rows, replaceMode, chunkIndex, chunkTotal, configFields } = parsed;

  await upsertMonthConfig({ bulan, ...configFields });
  res.json({ ok: true, bulan, received: rows.length, replace_mode: replaceMode, chunk_index: chunkIndex, chunk_total: chunkTotal });

  setImmediate(async () => {
    try {
      const result = await syncSingleRowPerOutlet({
        table: 'dm_ct_raw_aktivasi',
        dateColumn: 'tanggal_aktivasi',
        dateCandidates: TANGGAL_AKTIVASI_CANDIDATES,
        bulan, rows,
        shouldDelete: replaceMode === 'replace',
      });
      await logSyncResult({ bulan, sourceType: 'aktivasi', ...result, status: 'success' });
      console.log(`[dm-control-tower aktivasi sync] bulan ${bulan} chunk ${chunkIndex ?? '-'}/${chunkTotal ?? '-'} (${replaceMode}): ${result.inserted} outlet, ${result.skipped} dilewati (id kosong)`);
    } catch (err) {
      console.error('[dm-control-tower aktivasi sync] error:', err.message);
      await logSyncResult({ bulan, sourceType: 'aktivasi', received: rows.length, status: 'error', errorMessage: err.message });
    }
  });
}

async function trxSyncHandler(req, res) {
  const parsed = validateSyncBody(req, res);
  if (!parsed) return;
  const { bulan, rows, replaceMode, chunkIndex, chunkTotal, configFields } = parsed;

  await upsertMonthConfig({ bulan, ...configFields });
  res.json({ ok: true, bulan, received: rows.length, replace_mode: replaceMode, chunk_index: chunkIndex, chunk_total: chunkTotal });

  setImmediate(async () => {
    try {
      const result = await syncTrxRows({ bulan, rows, shouldDelete: replaceMode === 'replace' });
      await logSyncResult({ bulan, sourceType: 'trx', ...result, status: 'success' });
      console.log(`[dm-control-tower trx sync] bulan ${bulan} chunk ${chunkIndex ?? '-'}/${chunkTotal ?? '-'} (${replaceMode}): ${result.inserted} baris, ${result.skipped} dilewati (id kosong)`);
    } catch (err) {
      console.error('[dm-control-tower trx sync] error:', err.message);
      await logSyncResult({ bulan, sourceType: 'trx', received: rows.length, status: 'error', errorMessage: err.message });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════
// ANALYTICS — dihitung dari raw data (requireAuth, didaftarkan di app.js)
// ═══════════════════════════════════════════════════════════════════════
//
// Semua query di bawah dibangun di atas 1 CTE bersama ("classified"): gabung
// register + aktivasi + transaksi per id_outlet untuk 1 bulan, hitung H_Reg
// (first tx date - tanggal register) & H_Akt (first tx date - tanggal
// aktivasi) dalam hari, lalu klasifikasi ke 1 dari 8 segmen (mutually
// exclusive, dievaluasi sebagai cascade — pola sama seperti stage engine di
// warroom-qris-control-tower.js).
//
// DEFINISI FINAL (dikonfirmasi pemilik produk, menggantikan asumsi awal Prompt 1):
//   registered_only      — sudah registrasi, belum aktivasi, belum transaksi (masih dalam masa
//                           tunggu — cohort belum matang/belum lewat H3)
//   activated_no_tx      — sudah aktivasi, belum pernah transaksi (masih dalam masa tunggu)
//   tx1_h0_h3            — transaksi PERTAMA terjadi dalam H0-H3 sejak tanggal registrasi
//   repeat_h0_h3         — outlet punya MINIMAL 2 transaksi dalam H0-H3 sejak tanggal registrasi
//   late_tx              — transaksi pertama terjadi SETELAH H3 (kasus langka: cohort belum matang
//                           tapi entah bagaimana sudah ada transaksi >H3 di bulan yang sama —
//                           lihat catatan di bawah kenapa ini jarang terjadi)
//   handoff_farming      — **METRIC BISNIS UTAMA.** Registrasi sudah lewat H3 (cohort matang)
//                           TAPI belum berhasil Tx1 dalam H0-H3 sama sekali (tidak peduli sudah
//                           aktivasi atau belum) — outlet ini yang perlu "dilempar" ke tim farming.
//   active_after_handoff — outlet yang gagal Tx1 di H0-H3 (cohort matang, sempat masuk kandidat
//                           handoff), TAPI akhirnya bertransaksi juga setelah H3.
//   anomaly              — masalah kualitas data: transaksi sebelum registrasi/aktivasi, dsb.
//                           (id kosong & tanggal invalid sudah difilter/dicatat terpisah saat sync,
//                           lihat computeDataQuality — tidak masuk tabel ini sama sekali)
//
// CATATAN "late_tx" vs "active_after_handoff": keduanya sama-sama berarti
// "transaksi pertama setelah H3" secara matematis. Pembedanya adalah status
// KEMATANGAN cohort (is_mature): kalau cohort SUDAH matang (register cukup
// awal sehingga window H0-H3 sudah pasti lewat), first-tx yang telat masuk
// "active_after_handoff" (mereka sempat jadi kandidat handoff, lalu convert).
// Kalau cohort BELUM matang tapi entah bagaimana sudah ada tx >H3 di bulan
// yang sama, itu masuk "late_tx" — secara praktik ini SANGAT JARANG terjadi,
// karena data transaksi di-scope per bulan (bulan=$1); register di 3 hari
// terakhir bulan (belum matang) hampir tidak mungkin punya transaksi >H3
// hari sesudahnya yang MASIH di bulan yang sama. "late_tx" tetap disediakan
// sebagai jaring pengaman/sinyal kualitas data, bukan segmen populasi besar.
//
// Priority action queue final (dikonfirmasi):
//   P0 — anomaly (masalah kualitas data)
//   P1 — activated_no_tx (sudah aktivasi, belum transaksi H0-H3), handoff_farming (metric bisnis
//        utama — TAMBAHAN saya: tidak disebut eksplisit di 4-tier asli, saya taruh P1 karena ini
//        "metric bisnis utama" yang butuh eskalasi ke farming, mohon dikonfirmasi kalau maunya beda)
//   P2 — registered_only (sudah registrasi, belum aktivasi sampai H3), late_tx (TAMBAHAN saya,
//        kasus langka, prioritas menengah karena akhirnya tetap transaksi)
//   P3 — tx1_h0_h3 / repeat_h0_h3 / active_after_handoff (sehat)

const SEGMENT_PRIORITY = Object.freeze({
  anomaly:              'P0',
  activated_no_tx:      'P1',
  handoff_farming:      'P1',
  registered_only:      'P2',
  late_tx:              'P2',
  tx1_h0_h3:            'P3',
  repeat_h0_h3:         'P3',
  active_after_handoff: 'P3',
  unknown:              'P2',
});

const SEGMENT_SQL_ORDER = `
  CASE segment
    WHEN 'anomaly' THEN 0
    WHEN 'activated_no_tx' THEN 1
    WHEN 'handoff_farming' THEN 1
    WHEN 'registered_only' THEN 2
    WHEN 'late_tx' THEN 2
    ELSE 3
  END`;

const SEGMENT_SQL_PRIORITY = `
  CASE segment
    WHEN 'anomaly' THEN 'P0'
    WHEN 'activated_no_tx' THEN 'P1'
    WHEN 'handoff_farming' THEN 'P1'
    WHEN 'registered_only' THEN 'P2'
    WHEN 'late_tx' THEN 'P2'
    ELSE 'P3'
  END`;

/**
 * CTE bersama: $1 = bulan, $2 = mature_cohort_end (date string 'YYYY-MM-DD').
 * "classified" berisi 1 baris per id_outlet yang muncul di SALAH SATU dari
 * register/aktivasi/trx pada bulan tsb, plus kolom h_reg/h_akt/segment/is_mature.
 */
const CLASSIFIED_CTE = `
WITH reg AS (
  SELECT id_outlet, tanggal_register FROM dm_ct_raw_register WHERE bulan = $1
),
akt AS (
  SELECT id_outlet, tanggal_aktivasi FROM dm_ct_raw_aktivasi WHERE bulan = $1
),
trx_agg AS (
  SELECT
    id_outlet,
    MIN(tanggal_transaksi) AS first_tx_date,
    MAX(tanggal_transaksi) AS last_tx_date,
    COUNT(DISTINCT tanggal_transaksi) AS distinct_tx_days,
    COUNT(*) AS trx_rows,
    COALESCE(SUM(trx_count), 0) AS total_trx,
    COALESCE(SUM(margin), 0) AS total_margin
  FROM dm_ct_raw_trx
  WHERE bulan = $1
  GROUP BY id_outlet
),
ids AS (
  SELECT id_outlet FROM reg
  UNION SELECT id_outlet FROM akt
  UNION SELECT id_outlet FROM trx_agg
),
base AS (
  SELECT
    ids.id_outlet,
    reg.tanggal_register,
    akt.tanggal_aktivasi,
    trx_agg.first_tx_date,
    trx_agg.last_tx_date,
    trx_agg.distinct_tx_days,
    trx_agg.trx_rows,
    trx_agg.total_trx,
    trx_agg.total_margin,
    CASE WHEN reg.tanggal_register IS NOT NULL AND trx_agg.first_tx_date IS NOT NULL
         THEN (trx_agg.first_tx_date - reg.tanggal_register) END AS h_reg,
    CASE WHEN akt.tanggal_aktivasi IS NOT NULL AND trx_agg.first_tx_date IS NOT NULL
         THEN (trx_agg.first_tx_date - akt.tanggal_aktivasi) END AS h_akt
  FROM ids
  LEFT JOIN reg     ON reg.id_outlet = ids.id_outlet
  LEFT JOIN akt     ON akt.id_outlet = ids.id_outlet
  LEFT JOIN trx_agg ON trx_agg.id_outlet = ids.id_outlet
),
classified AS (
  SELECT *,
    (tanggal_register IS NOT NULL AND tanggal_register <= $2::date) AS is_mature,
    CASE
      -- P0: transaksi tercatat sebelum register/aktivasi = data bermasalah.
      WHEN h_reg < 0 OR h_akt < 0 THEN 'anomaly'
      -- Tx1 terjadi di dalam window H0-H3 sejak register.
      WHEN h_reg BETWEEN 0 AND 3 AND distinct_tx_days >= 2 THEN 'repeat_h0_h3'
      WHEN h_reg BETWEEN 0 AND 3 THEN 'tx1_h0_h3'
      -- Tx1 terjadi SETELAH H3. Kalau cohort sudah matang (register <= mature
      -- cohort end), outlet ini sempat jadi kandidat handoff lalu akhirnya
      -- convert juga -> active_after_handoff. Kalau belum matang, edge case
      -- langka -> late_tx (lihat catatan di header module).
      WHEN h_reg > 3 AND tanggal_register IS NOT NULL AND tanggal_register <= $2::date THEN 'active_after_handoff'
      WHEN h_reg > 3 THEN 'late_tx'
      -- Belum pernah transaksi sama sekali. Cohort sudah matang (window H0-H3
      -- sudah pasti lewat) tapi tetap nol transaksi -> metric bisnis utama,
      -- perlu dilempar ke farming.
      WHEN first_tx_date IS NULL AND tanggal_register IS NOT NULL AND tanggal_register <= $2::date THEN 'handoff_farming'
      WHEN tanggal_aktivasi IS NOT NULL THEN 'activated_no_tx'
      WHEN tanggal_register IS NOT NULL THEN 'registered_only'
      ELSE 'unknown'
    END AS segment
  FROM base
)
`;

/** GET /api/warroom/dm-control-tower/months */
async function monthsHandler(req, res) {
  try {
    // Ambil DISTINCT bulan dari ke-3 tabel raw sekaligus, lalu hitung count &
    // last_sync per bulan per tabel (supaya kelihatan kalau 1 bulan cuma sync
    // sebagian sumber, mis. register sudah tapi trx belum).
    const bulanListRes = await pool.query(`
      SELECT bulan FROM dm_ct_raw_register
      UNION SELECT bulan FROM dm_ct_raw_aktivasi
      UNION SELECT bulan FROM dm_ct_raw_trx
      ORDER BY bulan DESC
    `);
    const bulanList = bulanListRes.rows.map(r2 => r2.bulan);
    if (!bulanList.length) return res.json({ months: [] });

    const detail = await Promise.all(bulanList.map(async (bulan) => {
      const [regR, aktR, trxR] = await Promise.all([
        pool.query('SELECT COUNT(*) AS n, MAX(synced_at) AS t FROM dm_ct_raw_register WHERE bulan=$1', [bulan]),
        pool.query('SELECT COUNT(*) AS n, MAX(synced_at) AS t FROM dm_ct_raw_aktivasi WHERE bulan=$1', [bulan]),
        pool.query('SELECT COUNT(*) AS n, MAX(synced_at) AS t FROM dm_ct_raw_trx WHERE bulan=$1', [bulan]),
      ]);
      const times = [regR.rows[0].t, aktR.rows[0].t, trxR.rows[0].t].filter(Boolean);
      return {
        bulan,
        total_register: Number(regR.rows[0].n),
        total_aktivasi: Number(aktR.rows[0].n),
        total_trx_rows: Number(trxR.rows[0].n),
        last_sync: times.length ? times.sort().pop() : null,
      };
    }));

    res.json({ months: detail });
  } catch (err) {
    console.error('[dm-control-tower months]', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Cek kualitas data untuk 1 bulan. Dipakai oleh analyticsHandler (ringkas,
 * tanpa contoh baris) dan dataQualityHandler (lengkap, dengan contoh baris
 * dibatasi per jenis supaya total response tidak membengkak).
 */
async function computeDataQuality(bulan, { exampleLimit = 20 } = {}) {
  const checks = [];
  // Beberapa cek di bawah reuse CLASSIFIED_CTE (butuh param $2=mature_cohort_end)
  // walau tidak memakai kolom is_mature — tetap dihitung dari config bulan
  // (fallback kalender kalau config belum ada), bukan tanggal dummy.
  const { matureCohortEnd } = await resolveMonthConfig(bulan);

  const addCheck = async (checkType, description, sql, params) => {
    const r = await pool.query(sql, params);
    checks.push({
      check_type: checkType,
      description,
      count: r.rows.length,
      examples: r.rows.slice(0, exampleLimit),
    });
  };

  await Promise.all([
    // 1-2: secara teori selalu 0 karena UNIQUE(bulan, id_outlet) di tabel —
    // tetap dicek sebagai jaring pengaman kalau constraint pernah dilonggarkan.
    addCheck(
      'duplicate_register',
      'id_outlet muncul lebih dari sekali di data register bulan ini',
      `SELECT id_outlet, COUNT(*) AS jumlah FROM dm_ct_raw_register WHERE bulan=$1 GROUP BY id_outlet HAVING COUNT(*) > 1 LIMIT 200`,
      [bulan]
    ),
    addCheck(
      'duplicate_aktivasi',
      'id_outlet muncul lebih dari sekali di data aktivasi bulan ini',
      `SELECT id_outlet, COUNT(*) AS jumlah FROM dm_ct_raw_aktivasi WHERE bulan=$1 GROUP BY id_outlet HAVING COUNT(*) > 1 LIMIT 200`,
      [bulan]
    ),
    addCheck(
      'duplicate_outlet_date_trx',
      'Outlet yang sama punya lebih dari 1 baris transaksi pada tanggal yang sama (mungkin wajar kalau memang multi-transaksi/hari, tapi perlu dicek)',
      `SELECT id_outlet, tanggal_transaksi, COUNT(*) AS jumlah
       FROM dm_ct_raw_trx WHERE bulan=$1 AND tanggal_transaksi IS NOT NULL
       GROUP BY id_outlet, tanggal_transaksi HAVING COUNT(*) > 1
       ORDER BY jumlah DESC LIMIT 200`,
      [bulan]
    ),
    addCheck(
      'trx_before_register',
      'Ada transaksi dengan tanggal SEBELUM tanggal register outlet tersebut',
      `${CLASSIFIED_CTE} SELECT id_outlet, tanggal_register, first_tx_date, h_reg FROM classified WHERE h_reg < 0 ORDER BY h_reg ASC LIMIT 200`,
      [bulan, matureCohortEnd]
    ),
    addCheck(
      'trx_before_aktivasi',
      'Ada transaksi dengan tanggal SEBELUM tanggal aktivasi outlet tersebut',
      `${CLASSIFIED_CTE} SELECT id_outlet, tanggal_aktivasi, first_tx_date, h_akt FROM classified WHERE h_akt < 0 ORDER BY h_akt ASC LIMIT 200`,
      [bulan, matureCohortEnd]
    ),
    addCheck(
      'trx_outlet_tidak_ada_di_register',
      'Outlet punya transaksi tapi tidak ditemukan di data register bulan ini',
      `${CLASSIFIED_CTE} SELECT id_outlet, first_tx_date, total_trx FROM classified WHERE first_tx_date IS NOT NULL AND tanggal_register IS NULL LIMIT 200`,
      [bulan, matureCohortEnd]
    ),
    addCheck(
      'trx_outlet_tidak_ada_di_aktivasi',
      'Outlet punya transaksi tapi tidak ditemukan di data aktivasi bulan ini',
      `${CLASSIFIED_CTE} SELECT id_outlet, first_tx_date, total_trx FROM classified WHERE first_tx_date IS NOT NULL AND tanggal_aktivasi IS NULL LIMIT 200`,
      [bulan, matureCohortEnd]
    ),
    addCheck(
      'aktivasi_tanpa_register',
      'Outlet sudah aktivasi tapi tidak ditemukan di data register bulan ini',
      `${CLASSIFIED_CTE} SELECT id_outlet, tanggal_aktivasi FROM classified WHERE tanggal_aktivasi IS NOT NULL AND tanggal_register IS NULL LIMIT 200`,
      [bulan, matureCohortEnd]
    ),
    addCheck(
      'register_tanpa_aktivasi',
      'Outlet sudah register tapi belum ada data aktivasi bulan ini',
      `${CLASSIFIED_CTE} SELECT id_outlet, tanggal_register FROM classified WHERE tanggal_register IS NOT NULL AND tanggal_aktivasi IS NULL LIMIT 200`,
      [bulan, matureCohortEnd]
    ),
    addCheck(
      'aktivasi_tanpa_transaksi',
      'Outlet sudah aktivasi tapi belum pernah transaksi sama sekali bulan ini',
      `${CLASSIFIED_CTE} SELECT id_outlet, tanggal_aktivasi FROM classified WHERE tanggal_aktivasi IS NOT NULL AND first_tx_date IS NULL LIMIT 200`,
      [bulan, matureCohortEnd]
    ),
  ]);

  // id_outlet_kosong & tanggal_invalid: dicegah/di-drop saat sync (baris tanpa
  // id_outlet valid otomatis dilewati — lihat skipped count di dm_ct_sync_log,
  // dan tanggal yang gagal parse otomatis jadi NULL di kolom, bukan error).
  // Dicatat di sini sebagai informasi, bukan hasil query baris-per-baris.
  checks.push({
    check_type: 'id_outlet_kosong',
    description: 'Baris tanpa id_outlet valid — otomatis DILEWATI saat sync (lihat rows_skipped di riwayat sync), tidak pernah tersimpan ke tabel',
    count: 0,
    examples: [],
    note: 'Lihat GET .../months atau tabel dm_ct_sync_log untuk jumlah baris yang dilewati per sync.',
  });
  checks.push({
    check_type: 'tanggal_invalid',
    description: 'Tanggal yang tidak bisa di-parse otomatis disimpan sebagai NULL (bukan error) — cek kolom tanggal_register/aktivasi/transaksi yang NULL padahal id_outlet-nya valid untuk menelusuri baris asal',
    count: 0,
    examples: [],
    note: 'Prompt 1 belum melacak "tanggal asli sebelum gagal parse" secara terpisah — kalau perlu, bisa ditambahkan di Prompt selanjutnya.',
  });

  return checks;
}

/** GET /api/warroom/dm-control-tower/data-quality?bulan=YYYY-MM */
async function dataQualityHandler(req, res) {
  try {
    const { bulan } = req.query;
    if (!isValidBulan(bulan)) return res.status(400).json({ error: 'bulan wajib format YYYY-MM' });
    const checks = await computeDataQuality(bulan, { exampleLimit: 50 });
    res.json({ bulan, checks });
  } catch (err) {
    console.error('[dm-control-tower data-quality]', err);
    res.status(500).json({ error: err.message });
  }
}

/** GET /api/warroom/dm-control-tower/analytics?bulan=YYYY-MM */
async function analyticsHandler(req, res) {
  try {
    const { bulan } = req.query;
    if (!isValidBulan(bulan)) return res.status(400).json({ error: 'bulan wajib format YYYY-MM' });

    const { periodStart, periodEnd, matureCohortEnd, configSource, configUpdatedAt } = await resolveMonthConfig(bulan);
    const params = [bulan, matureCohortEnd];

    const [
      summaryRes, segmentRes, cohortRes, h03Res, actionRes,
      topMarginRes, topRepeatRes, calendarRes, lastSyncRes,
    ] = await Promise.all([
      pool.query(`${CLASSIFIED_CTE}
        SELECT
          COUNT(*) FILTER (WHERE tanggal_register IS NOT NULL) AS total_registrasi,
          COUNT(*) FILTER (WHERE tanggal_aktivasi IS NOT NULL) AS total_aktivasi,
          COUNT(*) FILTER (WHERE first_tx_date IS NOT NULL) AS total_outlet_transaksi,
          COALESCE(SUM(total_trx), 0) AS total_transaksi,
          COALESCE(SUM(total_margin), 0) AS total_margin,
          COUNT(*) FILTER (WHERE is_mature) AS mature_cohort_count,
          COUNT(*) FILTER (WHERE is_mature AND h_reg BETWEEN 0 AND 3) AS reg_to_tx1_h0_h3,
          COUNT(*) FILTER (WHERE tanggal_aktivasi IS NOT NULL AND h_akt BETWEEN 0 AND 3) AS valid_akt_to_tx1,
          COUNT(*) FILTER (WHERE segment = 'repeat_h0_h3') AS early_repeat_count,
          COUNT(*) FILTER (WHERE segment = 'handoff_farming') AS handoff_farming_count,
          COUNT(*) FILTER (WHERE segment = 'anomaly') AS anomaly_count
        FROM classified`, params),

      pool.query(`${CLASSIFIED_CTE}
        SELECT segment, COUNT(*) AS count FROM classified GROUP BY segment ORDER BY count DESC`, params),

      pool.query(`${CLASSIFIED_CTE}
        SELECT
          tanggal_register AS cohort_date,
          COUNT(*) AS total_registrasi,
          COUNT(*) FILTER (WHERE tanggal_aktivasi IS NOT NULL AND (tanggal_aktivasi - tanggal_register) BETWEEN 0 AND 3) AS aktivasi_h3,
          COUNT(*) FILTER (WHERE h_reg BETWEEN 0 AND 3) AS tx1_h3,
          COUNT(*) FILTER (WHERE h_reg BETWEEN 0 AND 3 AND distinct_tx_days >= 2) AS repeat_h3,
          COALESCE(SUM(total_trx) FILTER (WHERE h_reg BETWEEN 0 AND 3), 0) AS trx_h3,
          COALESCE(SUM(total_margin) FILTER (WHERE h_reg BETWEEN 0 AND 3), 0) AS margin_h3
        FROM classified
        WHERE tanggal_register IS NOT NULL
        GROUP BY tanggal_register ORDER BY tanggal_register`, params),

      // h03_activity: per hari-offset (0-3) dari tanggal register, aktivitas transaksi ril
      // (per-baris transaksi, bukan hanya first-tx) — lebih presisi dari sekadar h_reg di atas.
      pool.query(`
        SELECT (t.tanggal_transaksi - r.tanggal_register) AS day_offset,
          COUNT(DISTINCT t.id_outlet) AS outlet_count,
          COUNT(*) AS trx_rows,
          COALESCE(SUM(t.trx_count), 0) AS total_trx,
          COALESCE(SUM(t.margin), 0) AS total_margin
        FROM dm_ct_raw_trx t
        JOIN dm_ct_raw_register r ON r.bulan = t.bulan AND r.id_outlet = t.id_outlet
        WHERE t.bulan = $1 AND t.tanggal_transaksi IS NOT NULL AND r.tanggal_register IS NOT NULL
          AND (t.tanggal_transaksi - r.tanggal_register) BETWEEN 0 AND 3
        GROUP BY day_offset ORDER BY day_offset`, [bulan]),

      pool.query(`${CLASSIFIED_CTE}
        SELECT id_outlet, segment, ${SEGMENT_SQL_PRIORITY} AS priority,
          tanggal_register, tanggal_aktivasi, first_tx_date, h_reg, h_akt, total_trx, total_margin
        FROM classified
        ORDER BY ${SEGMENT_SQL_ORDER}, tanggal_register DESC NULLS LAST
        LIMIT 300`, params),

      pool.query(`${CLASSIFIED_CTE}
        SELECT id_outlet, segment, total_trx, total_margin
        FROM classified WHERE total_margin > 0
        ORDER BY total_margin DESC LIMIT 20`, params),

      pool.query(`${CLASSIFIED_CTE}
        SELECT id_outlet, segment, distinct_tx_days, total_trx, total_margin
        FROM classified WHERE distinct_tx_days >= 2
        ORDER BY distinct_tx_days DESC, total_trx DESC LIMIT 20`, params),

      pool.query(`
        WITH days AS (
          SELECT generate_series($2::date, $3::date, interval '1 day')::date AS tanggal
        ),
        reg_d AS (SELECT tanggal_register AS tanggal, COUNT(*) AS cnt FROM dm_ct_raw_register WHERE bulan=$1 GROUP BY tanggal_register),
        akt_d AS (SELECT tanggal_aktivasi AS tanggal, COUNT(*) AS cnt FROM dm_ct_raw_aktivasi WHERE bulan=$1 GROUP BY tanggal_aktivasi),
        trx_d AS (SELECT tanggal_transaksi AS tanggal, COUNT(DISTINCT id_outlet) AS outlets, COALESCE(SUM(trx_count),0) AS trx, COALESCE(SUM(margin),0) AS margin
                   FROM dm_ct_raw_trx WHERE bulan=$1 GROUP BY tanggal_transaksi)
        SELECT days.tanggal,
          COALESCE(reg_d.cnt, 0) AS registrasi,
          COALESCE(akt_d.cnt, 0) AS aktivasi,
          COALESCE(trx_d.outlets, 0) AS outlet_transaksi,
          COALESCE(trx_d.trx, 0) AS total_trx,
          COALESCE(trx_d.margin, 0) AS total_margin
        FROM days
        LEFT JOIN reg_d ON reg_d.tanggal = days.tanggal
        LEFT JOIN akt_d ON akt_d.tanggal = days.tanggal
        LEFT JOIN trx_d ON trx_d.tanggal = days.tanggal
        ORDER BY days.tanggal`, [bulan, periodStart, periodEnd]),

      pool.query(`
        SELECT MAX(t) AS last_sync FROM (
          SELECT MAX(synced_at) AS t FROM dm_ct_raw_register WHERE bulan=$1
          UNION ALL SELECT MAX(synced_at) FROM dm_ct_raw_aktivasi WHERE bulan=$1
          UNION ALL SELECT MAX(synced_at) FROM dm_ct_raw_trx WHERE bulan=$1
        ) x`, [bulan]),
    ]);

    const s = summaryRes.rows[0] || {};
    const totalRegistrasi = Number(s.total_registrasi || 0);
    const totalAktivasi = Number(s.total_aktivasi || 0);
    const totalTransaksi = Number(s.total_transaksi || 0);
    const totalMargin = Number(s.total_margin || 0);
    const earlyRepeatCount = Number(s.early_repeat_count || 0);
    const regToTx1 = Number(s.reg_to_tx1_h0_h3 || 0);
    const matureCohortCount = Number(s.mature_cohort_count || 0);

    const dataQuality = await computeDataQuality(bulan, { exampleLimit: 0 }); // ringkas: count saja, tanpa contoh baris

    res.json({
      meta: {
        bulan,
        period_start: periodStart,
        period_end: periodEnd,
        mature_cohort_end: matureCohortEnd,
        // 'config' = semua 3 field dari dm_ct_month_config (dikirim Apps Script
        // dari 01_CONFIG); 'fallback' = belum ada config, pakai kalender murni
        // (akhir bulan - 3 hari); 'partial' = campuran keduanya.
        config_source: configSource,
        config_updated_at: configUpdatedAt,
        last_sync: lastSyncRes.rows[0]?.last_sync || null,
      },
      summary: {
        total_registrasi: totalRegistrasi,
        total_aktivasi: totalAktivasi,
        activation_rate: totalRegistrasi ? Number(((totalAktivasi / totalRegistrasi) * 100).toFixed(2)) : 0,
        total_outlet_transaksi: Number(s.total_outlet_transaksi || 0),
        total_transaksi: totalTransaksi,
        total_margin: totalMargin,
        avg_margin_per_trx: totalTransaksi ? Number((totalMargin / totalTransaksi).toFixed(2)) : 0,
        mature_cohort_count: matureCohortCount,
        reg_to_tx1_h0_h3: regToTx1,
        reg_to_tx1_h0_h3_rate: matureCohortCount ? Number(((regToTx1 / matureCohortCount) * 100).toFixed(2)) : 0,
        valid_akt_to_tx1: Number(s.valid_akt_to_tx1 || 0),
        // "early_repeat" = outlet yang berhasil repeat (>=2x transaksi) DI DALAM H0-H3
        // (segment repeat_h0_h3 saja — handoff_farming BUKAN early repeat, itu justru
        // kebalikannya: gagal total Tx1 setelah cohort matang, lihat handoff_rate).
        early_repeat_count: earlyRepeatCount,
        early_repeat_rate: regToTx1 ? Number(((earlyRepeatCount / regToTx1) * 100).toFixed(2)) : 0,
        // handoff_farming = METRIC BISNIS UTAMA: outlet dari cohort yang sudah matang
        // (lewat H3) tapi belum pernah berhasil Tx1 sama sekali -> perlu dilempar ke
        // tim farming. Rate dihitung dari total cohort yang SUDAH matang (bukan dari
        // total aktivasi), karena handoff_farming tidak bergantung status aktivasi.
        handoff_farming: Number(s.handoff_farming_count || 0),
        handoff_rate: matureCohortCount ? Number(((Number(s.handoff_farming_count || 0) / matureCohortCount) * 100).toFixed(2)) : 0,
        data_quality_issues: dataQuality.reduce((sum, c) => sum + c.count, 0),
      },
      funnel: {
        registrasi: totalRegistrasi,
        aktivasi: totalAktivasi,
        tx1_h0_h3: regToTx1,
        repeat_h0_h3: earlyRepeatCount,
      },
      calendar_daily: calendarRes.rows,
      cohort_daily: cohortRes.rows,
      h03_activity: h03Res.rows,
      data_quality: dataQuality.map(c => ({ check_type: c.check_type, description: c.description, count: c.count })),
      segment_counts: segmentRes.rows,
      action_queue: actionRes.rows,
      top_margin_outlets: topMarginRes.rows,
      top_repeat_outlets: topRepeatRes.rows,
    });
  } catch (err) {
    console.error('[dm-control-tower analytics]', err);
    res.status(500).json({ error: err.message });
  }
}

/** GET /api/warroom/dm-control-tower/outlets?bulan=&page=&limit=&search=&segment= */
async function outletsHandler(req, res) {
  try {
    const { bulan } = req.query;
    if (!isValidBulan(bulan)) return res.status(400).json({ error: 'bulan wajib format YYYY-MM' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const segment = (req.query.segment || '').trim();

    const { matureCohortEnd } = await resolveMonthConfig(bulan);
    const params = [bulan, matureCohortEnd];
    const conditions = [];

    if (search) {
      params.push(`%${search.toUpperCase()}%`);
      conditions.push(`UPPER(id_outlet) LIKE $${params.length}`);
    }
    if (segment) {
      params.push(segment);
      conditions.push(`segment = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [countRes, dataRes] = await Promise.all([
      pool.query(`${CLASSIFIED_CTE} SELECT COUNT(*) FROM classified ${where}`, params),
      pool.query(
        `${CLASSIFIED_CTE}
         SELECT id_outlet, segment, ${SEGMENT_SQL_PRIORITY} AS priority,
           tanggal_register, tanggal_aktivasi, first_tx_date, last_tx_date,
           h_reg, h_akt, distinct_tx_days, total_trx, total_margin
         FROM classified ${where}
         ORDER BY total_margin DESC, id_outlet
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    res.json({
      bulan,
      outlets: dataRes.rows,
      total: Number(countRes.rows[0].count),
      page, limit,
    });
  } catch (err) {
    console.error('[dm-control-tower outlets]', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  // di-export supaya bisa dites unit test terpisah nanti tanpa perlu DB
  normalizeKey, normalizeRowKeys, pick, nullIfEmpty,
  parseFlexibleDate, cleanNum, computeRowHash, isValidBulan, getPeriodBounds,
  resolveMonthConfig, upsertMonthConfig,
  ID_OUTLET_CANDIDATES, TANGGAL_REGISTER_CANDIDATES, TANGGAL_AKTIVASI_CANDIDATES,
  TANGGAL_TRANSAKSI_CANDIDATES, MARGIN_CANDIDATES, TRX_COUNT_CANDIDATES,
  SEGMENT_PRIORITY,
  // Express handlers — sync (token auth, sebelum requireAuth di app.js)
  registerSyncHandler, aktivasiSyncHandler, trxSyncHandler,
  // Express handlers — analytics (requireAuth)
  monthsHandler, analyticsHandler, dataQualityHandler, outletsHandler,
};
