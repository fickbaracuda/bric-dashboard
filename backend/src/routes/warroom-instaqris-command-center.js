/**
 * WAR-ROOM InstaQRIS Command Center — Prompt 1 (backend analytics only)
 *
 * Tujuan: memberi ringkasan eksekutif (bukan CEO — "CEO" hanya persona pengguna,
 * bukan nama fitur) lintas 3 tabel raw InstaQRIS yang sudah ada:
 *   - iq_raw_outlet  (katalog outlet/merchant per bulan)
 *   - iq_raw_qris    (status penerbitan QRIS per bulan)
 *   - iq_raw_trx     (transaksi harian per bulan)
 * Semua tabel menyimpan baris asli sebagai JSONB (`row_data`) — TIDAK ada kolom
 * terstruktur. Nama kolom di sheet sumber tidak konsisten antar bulan/lampiran
 * (contoh nyata: "ID Outlet" vs "D Outlet" — lihat data-raw.js), sehingga file
 * ini memakai helper "canonical field" yang mencoba beberapa kandidat nama
 * kolom sebelum menyerah ke NULL.
 *
 * TIDAK ADA endpoint sync di file ini — sinkronisasi tetap lewat
 * data-raw.js (outlet/affiliate/qris/trx). File ini murni READ-ONLY.
 *
 * TIDAK mengubah query/handler yang sudah ada di data-raw.js maupun war-room
 * lain (QRIS Control Tower, DM Control Tower) — semua query di sini baru.
 */

const pool = require('../db');

// ─────────────────────────────────────────────────────────────────────────
// Kandidat nama kolom kanonik (lihat docs/INSTAQRIS_COMMAND_CENTER.md §2)
// ─────────────────────────────────────────────────────────────────────────
const ID_OUTLET_CANDIDATES   = ['ID Outlet', 'D Outlet', 'id_outlet', 'Id Outlet', 'Outlet ID', 'ID Loket', 'Kode Outlet'];
const MERCHANT_NAME_CANDIDATES = ['Nama Merchant', 'Merchant Name', 'nama_merchant', 'Nama Outlet', 'Nama Toko'];
const KATEGORI_CANDIDATES    = ['Nama Kategori', 'Kategori', 'MCC', 'Category'];
const PROVINSI_CANDIDATES    = ['Provinsi', 'Province', 'nama_propinsi', 'Nama Propinsi'];
const KOTA_CANDIDATES        = ['Kota', 'City', 'nama_kota', 'Nama Kota'];
const NO_HP_CANDIDATES       = ['No HP', 'No Handphone', 'No Telp', 'No Telepon', 'no_hp', 'notelp_pemilik'];
const TRX_CANDIDATES         = ['Jumlah Transaksi', 'Transaksi', 'trx', 'total_transaction', 'total_trx'];
// Catatan: "Margin" dan "Jumlah Omzet/Revenue" adalah 2 metrik BERBEDA di data
// nyata (lihat data-raw.js yang menjumlahkan keduanya secara terpisah), jadi
// TIDAK digabung jadi satu kandidat — supaya tidak salah tafsir angka.
const REVENUE_CANDIDATES     = ['Jumlah Omzet', 'Omzet', 'Revenue', 'revenue', 'Rev'];
const MARGIN_CANDIDATES      = ['Margin', 'margin', 'MDR'];
const TANGGAL_TRX_CANDIDATES = ['Tanggal', 'tanggal', 'Tanggal Transaksi', 'Tgl Transaksi'];
const STATUS_QRIS_CANDIDATES = ['status', 'Status', 'Status QRIS', 'QRIS Status', 'Status Penerbitan'];

/** Bangun ekspresi SQL COALESCE(NULLIF(...)) dari daftar kandidat kolom JSONB. */
function pickSql(candidates, colExpr = 'row_data') {
  const parts = candidates.map((c) => `NULLIF(${colExpr}->>'${c}', '')`);
  return `COALESCE(${parts.join(', ')})`;
}

/**
 * Ekspresi SQL numerik AMAN dari teks JSONB yang bisa berupa:
 *  - angka bersih ("408146.85")
 *  - berformat "Rp 98,484" (prefix Rp + koma ribuan)
 * Titik desimal TIDAK PERNAH dihapus — hanya prefix "Rp"/"rp" dan koma ribuan
 * yang dibersihkan (ini adalah versi SQL dari aturan cleanNum() lama: jangan
 * pernah strip karakter titik dari angka asli — insiden Speedcash 100x).
 * Kalau setelah dibersihkan hasilnya bukan angka valid, dikembalikan 0 (bukan
 * error) supaya 1 baris kotor tidak menggagalkan seluruh query agregat.
 */
function numericSql(candidates, colExpr = 'row_data') {
  const raw = pickSql(candidates, colExpr);
  const noRp = `regexp_replace(COALESCE(${raw}, ''), '[Rr][Pp]\\.?\\s*', '', 'g')`;
  const noComma = `regexp_replace(${noRp}, ',', '', 'g')`;
  return `(CASE WHEN ${noComma} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${noComma}::numeric ELSE 0 END)`;
}

const ID_OUTLET_SQL = pickSql(ID_OUTLET_CANDIDATES);
const KATEGORI_SQL  = pickSql(KATEGORI_CANDIDATES);
const PROVINSI_SQL  = pickSql(PROVINSI_CANDIDATES);
const STATUS_SQL    = pickSql(STATUS_QRIS_CANDIDATES);
const TRX_SQL        = numericSql(TRX_CANDIDATES);
const REVENUE_SQL    = numericSql(REVENUE_CANDIDATES);
const MARGIN_SQL     = numericSql(MARGIN_CANDIDATES);

// ─────────────────────────────────────────────────────────────────────────
// Helper umum
// ─────────────────────────────────────────────────────────────────────────
function isValidBulan(b) {
  return typeof b === 'string' && /^\d{4}-\d{2}$/.test(b);
}

function prevBulanStr(bulan) {
  const [y, m] = bulan.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function pct(numerator, denominator) {
  if (!denominator) return null;
  return +((numerator / denominator) * 100).toFixed(2);
}

function growthPct(curr, prev) {
  if (prev === null || prev === undefined) return null;
  if (prev === 0) return curr > 0 ? 100 : 0;
  return +(((curr - prev) / prev) * 100).toFixed(2);
}

/**
 * Pemetaan status QRIS mentah (bebas format/kapitalisasi) ke 5 kategori baku.
 * Urutan pengecekan SENGAJA: reject/perbaikan/belum dulu, baru terbit — supaya
 * teks ambigu seperti "Menunggu Terbit" tidak salah kebaca sebagai "terbit".
 */
function bucketQrisStatus(raw) {
  if (raw === null || raw === undefined) return 'unknown';
  const s = String(raw).trim();
  if (s === '') return 'unknown';
  const low = s.toLowerCase();
  if (low.includes('reject') || low.includes('tolak')) return 'rejected';
  if (low.includes('perbaikan') || low.includes('revisi') || low.includes('revision')) return 'perbaikan_data';
  if (low.includes('belum') || low.includes('pending') || low.includes('menunggu') || low.includes('proses')) return 'belum_terbit';
  if (low.includes('terbit') || low.includes('approve')) return 'terbit';
  return 'status_lain';
}

// Threshold terdokumentasi — lihat docs/INSTAQRIS_COMMAND_CENTER.md §6 untuk
// alasan tiap angka. Bukan hasil tuning statistik, tapi batas akal sehat awal
// yang bisa direvisi bersama business owner setelah data asli diamati.
const THRESHOLD = {
  QRIS_TERBIT_RATE_LOW: 50,          // % — di bawah ini dianggap bottleneck penerbitan
  ACTIVATION_RATE_LOW: 30,           // % outlet QRIS-terbit yang sudah transaksi
  DATA_QUALITY_ISSUE_RATE_HIGH: 5,   // % dari total record yang kena salah satu DQ check
  ACTIVE_RATE_CRITICAL: 5,           // % outlet terdaftar yang transaksi bulan ini
  REVENUE_DECLINE_WARNING: 0,        // growth % revenue < ini dianggap warning
  TOP_PERFORMER_PERCENTILE: 0.9,     // P90 revenue -> kandidat reward/testimoni
};

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/instaqris-command-center/months
// ─────────────────────────────────────────────────────────────────────────
async function monthsHandler(req, res) {
  try {
    const sql = `
      SELECT bulan FROM iq_raw_outlet
      UNION SELECT bulan FROM iq_raw_qris
      UNION SELECT bulan FROM iq_raw_trx
      ORDER BY bulan DESC
    `;
    const r = await pool.query(sql);
    const months = r.rows.map((row) => row.bulan);
    res.json({ months });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Query-query pendukung /analytics (masing-masing sudah ter-agregasi di DB —
// tidak ada yang mengembalikan baris level-outlet mentah ke caller).
// ─────────────────────────────────────────────────────────────────────────

async function getOutletBase(bulan) {
  const sql = `
    SELECT
      COUNT(*) AS total_rows,
      COUNT(DISTINCT ${ID_OUTLET_SQL}) FILTER (WHERE ${ID_OUTLET_SQL} IS NOT NULL) AS total_outlet,
      COUNT(*) FILTER (WHERE ${ID_OUTLET_SQL} IS NULL) AS outlet_tanpa_id
    FROM iq_raw_outlet WHERE bulan = $1
  `;
  const r = await pool.query(sql, [bulan]);
  const row = r.rows[0] || {};
  return {
    total_rows: Number(row.total_rows || 0),
    total_outlet: Number(row.total_outlet || 0),
    outlet_tanpa_id: Number(row.outlet_tanpa_id || 0),
  };
}

async function getTopBreakdown(bulan, fieldSql, limit = 10) {
  const sql = `
    SELECT COALESCE(${fieldSql}, 'Tidak Diketahui') AS label, COUNT(*) AS cnt
    FROM iq_raw_outlet
    WHERE bulan = $1
    GROUP BY label
    ORDER BY cnt DESC
    LIMIT ${limit}
  `; // limit selalu konstanta internal (10), bukan input user — aman diinline
  const r = await pool.query(sql, [bulan]);
  return r.rows.map((row) => ({ label: row.label, count: Number(row.cnt) }));
}

async function getQrisStatusBuckets(bulan) {
  const sql = `
    SELECT COALESCE(${STATUS_SQL}, '') AS raw_status, COUNT(*) AS cnt
    FROM iq_raw_qris WHERE bulan = $1
    GROUP BY raw_status
  `;
  const r = await pool.query(sql, [bulan]);
  const buckets = { terbit: 0, belum_terbit: 0, perbaikan_data: 0, rejected: 0, status_lain: 0, unknown: 0 };
  let total = 0;
  for (const row of r.rows) {
    const cnt = Number(row.cnt);
    total += cnt;
    buckets[bucketQrisStatus(row.raw_status)] += cnt;
  }
  return { ...buckets, total };
}

async function getTrxAggregate(bulan) {
  const sql = `
    SELECT
      COUNT(*) AS total_rows,
      COUNT(DISTINCT ${ID_OUTLET_SQL}) FILTER (WHERE ${ID_OUTLET_SQL} IS NOT NULL) AS active_outlet_trx,
      COUNT(*) FILTER (WHERE ${ID_OUTLET_SQL} IS NULL) AS trx_tanpa_id,
      COALESCE(SUM(${TRX_SQL}), 0) AS total_trx,
      COALESCE(SUM(${REVENUE_SQL}), 0) AS total_revenue,
      COALESCE(SUM(${MARGIN_SQL}), 0) AS total_margin
    FROM iq_raw_trx WHERE bulan = $1
  `;
  const r = await pool.query(sql, [bulan]);
  const row = r.rows[0] || {};
  return {
    total_rows: Number(row.total_rows || 0),
    active_outlet_trx: Number(row.active_outlet_trx || 0),
    trx_tanpa_id: Number(row.trx_tanpa_id || 0),
    total_trx: Number(row.total_trx || 0),
    total_revenue: Number(row.total_revenue || 0),
    total_margin: Number(row.total_margin || 0),
  };
}

/** Outlet terdaftar (bulan X) yang TIDAK punya transaksi sama sekali bulan X. */
async function getOutletTanpaTrx(bulan) {
  const sql = `
    SELECT COUNT(DISTINCT o_id) AS cnt FROM (
      SELECT ${ID_OUTLET_SQL} AS o_id FROM iq_raw_outlet WHERE bulan = $1
    ) sub
    WHERE o_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM iq_raw_trx t WHERE t.bulan = $1 AND ${pickSql(ID_OUTLET_CANDIDATES, 't.row_data')} = sub.o_id
    )
  `;
  const r = await pool.query(sql, [bulan]);
  return Number(r.rows[0]?.cnt || 0);
}

/** Transaksi (bulan X) yang id_outlet-nya tidak ditemukan di katalog outlet bulan X. */
async function getTrxTidakMatchOutlet(bulan) {
  const sql = `
    SELECT COUNT(DISTINCT t_id) AS cnt FROM (
      SELECT ${pickSql(ID_OUTLET_CANDIDATES, 'row_data')} AS t_id FROM iq_raw_trx WHERE bulan = $1
    ) sub
    WHERE t_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM iq_raw_outlet o WHERE o.bulan = $1 AND ${pickSql(ID_OUTLET_CANDIDATES, 'o.row_data')} = sub.t_id
    )
  `;
  const r = await pool.query(sql, [bulan]);
  return Number(r.rows[0]?.cnt || 0);
}

async function getQrisTanpaId(bulan) {
  const sql = `SELECT COUNT(*) AS cnt FROM iq_raw_qris WHERE bulan = $1 AND ${pickSql(ID_OUTLET_CANDIDATES, 'row_data')} IS NULL`;
  const r = await pool.query(sql, [bulan]);
  return Number(r.rows[0]?.cnt || 0);
}

async function getDuplicateOutletId(bulan) {
  const sql = `
    SELECT COUNT(*) AS cnt FROM (
      SELECT ${ID_OUTLET_SQL} AS oid FROM iq_raw_outlet WHERE bulan = $1
      GROUP BY oid HAVING COUNT(*) > 1
    ) dup WHERE oid IS NOT NULL
  `;
  const r = await pool.query(sql, [bulan]);
  return Number(r.rows[0]?.cnt || 0);
}

/** Outlet ber-QRIS Terbit tapi tidak ada transaksi sama sekali bulan ini (kandidat P1 aktivasi). */
async function getTerbitTanpaTrx(bulan) {
  const statusRaw = await pool.query(
    `SELECT ${pickSql(ID_OUTLET_CANDIDATES, 'row_data')} AS id_outlet, ${STATUS_SQL} AS raw_status
     FROM iq_raw_qris WHERE bulan = $1`,
    [bulan]
  );
  const terbitIds = new Set();
  for (const row of statusRaw.rows) {
    if (row.id_outlet && bucketQrisStatus(row.raw_status) === 'terbit') terbitIds.add(row.id_outlet);
  }
  if (terbitIds.size === 0) return 0;
  const trxRes = await pool.query(
    `SELECT DISTINCT ${pickSql(ID_OUTLET_CANDIDATES, 'row_data')} AS id_outlet FROM iq_raw_trx WHERE bulan = $1`,
    [bulan]
  );
  const trxIds = new Set(trxRes.rows.map((r) => r.id_outlet).filter(Boolean));
  let count = 0;
  for (const id of terbitIds) if (!trxIds.has(id)) count++;
  return count;
}

/** Outlet transaksi bulan lalu tapi tidak transaksi bulan ini (kandidat P3 retention). */
async function getChurnedFromPrevMonth(bulan, prevBulan) {
  const sql = `
    SELECT COUNT(DISTINCT p_id) AS cnt FROM (
      SELECT ${pickSql(ID_OUTLET_CANDIDATES, 'row_data')} AS p_id FROM iq_raw_trx WHERE bulan = $2
    ) sub
    WHERE p_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM iq_raw_trx c WHERE c.bulan = $1 AND ${pickSql(ID_OUTLET_CANDIDATES, 'c.row_data')} = sub.p_id
    )
  `;
  const r = await pool.query(sql, [bulan, prevBulan]);
  return Number(r.rows[0]?.cnt || 0);
}

/** Outlet top performer (>= P90 revenue) bulan ini — kandidat P4 growth/reward. */
async function getTopPerformerCount(bulan) {
  const sql = `
    WITH per_outlet AS (
      SELECT ${ID_OUTLET_SQL} AS id_outlet, SUM(${REVENUE_SQL}) AS rev
      FROM iq_raw_trx WHERE bulan = $1
      GROUP BY id_outlet HAVING ${ID_OUTLET_SQL} IS NOT NULL
    ), threshold AS (
      SELECT PERCENTILE_CONT(${THRESHOLD.TOP_PERFORMER_PERCENTILE}) WITHIN GROUP (ORDER BY rev) AS p90
      FROM per_outlet
    )
    SELECT COUNT(*) AS cnt FROM per_outlet, threshold WHERE per_outlet.rev >= threshold.p90 AND threshold.p90 > 0
  `;
  const r = await pool.query(sql, [bulan]);
  return Number(r.rows[0]?.cnt || 0);
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/warroom/instaqris-command-center/analytics?bulan=YYYY-MM
// ─────────────────────────────────────────────────────────────────────────
async function analyticsHandler(req, res) {
  try {
    const monthsRes = await pool.query(`
      SELECT bulan FROM iq_raw_outlet
      UNION SELECT bulan FROM iq_raw_qris
      UNION SELECT bulan FROM iq_raw_trx
      ORDER BY bulan DESC
    `);
    const bulanList = monthsRes.rows.map((r) => r.bulan);
    if (bulanList.length === 0) {
      return res.json({ empty: true, message: 'Belum ada data InstaQRIS yang tersinkron.' });
    }

    let bulan = req.query.bulan;
    if (!isValidBulan(bulan) || !bulanList.includes(bulan)) bulan = bulanList[0];
    const prevBulan = prevBulanStr(bulan);
    const hasPrevBulan = bulanList.includes(prevBulan);

    const [
      outletBase, topProvinsi, topKategori, qrisStatus, trxAgg,
      outletTanpaTrx, trxTidakMatchOutlet, qrisTanpaId, duplicateOutletId,
      lastSyncedOutlet, lastSyncedQris, lastSyncedTrx,
    ] = await Promise.all([
      getOutletBase(bulan),
      getTopBreakdown(bulan, PROVINSI_SQL),
      getTopBreakdown(bulan, KATEGORI_SQL),
      getQrisStatusBuckets(bulan),
      getTrxAggregate(bulan),
      getOutletTanpaTrx(bulan),
      getTrxTidakMatchOutlet(bulan),
      getQrisTanpaId(bulan),
      getDuplicateOutletId(bulan),
      pool.query('SELECT MAX(synced_at) AS t FROM iq_raw_outlet WHERE bulan = $1', [bulan]),
      pool.query('SELECT MAX(synced_at) AS t FROM iq_raw_qris WHERE bulan = $1', [bulan]),
      pool.query('SELECT MAX(synced_at) AS t FROM iq_raw_trx WHERE bulan = $1', [bulan]),
    ]);

    let prevTrxAgg = null;
    let prevQrisStatus = null;
    let churnedFromPrevMonth = null;
    if (hasPrevBulan) {
      [prevTrxAgg, prevQrisStatus, churnedFromPrevMonth] = await Promise.all([
        getTrxAggregate(prevBulan),
        getQrisStatusBuckets(prevBulan),
        getChurnedFromPrevMonth(bulan, prevBulan),
      ]);
    }

    const [terbitTanpaTrx, topPerformerCount] = await Promise.all([
      getTerbitTanpaTrx(bulan),
      getTopPerformerCount(bulan),
    ]);

    // ── KPI ────────────────────────────────────────────────────────────
    const outlet_registered = outletBase.total_outlet;
    const qris_terbit_rate = pct(qrisStatus.terbit, outlet_registered);
    const qris_problem_rate = pct(qrisStatus.perbaikan_data + qrisStatus.rejected, qrisStatus.total);
    const active_rate = pct(trxAgg.active_outlet_trx, outlet_registered);

    const kpi = {
      outlet: {
        total_outlet: outletBase.total_outlet,
        outlet_tanpa_id: outletBase.outlet_tanpa_id,
        top_provinsi: topProvinsi,
        top_kategori: topKategori,
      },
      qris_status: {
        qris_terbit: qrisStatus.terbit,
        qris_belum_terbit: qrisStatus.belum_terbit,
        qris_perbaikan_data: qrisStatus.perbaikan_data,
        qris_rejected: qrisStatus.rejected,
        qris_status_lain: qrisStatus.status_lain,
        qris_unknown: qrisStatus.unknown,
        qris_terbit_rate,
        qris_problem_rate,
        qris_terbit_growth: hasPrevBulan ? growthPct(qrisStatus.terbit, prevQrisStatus.terbit) : null,
      },
      transaksi: {
        active_outlet_trx: trxAgg.active_outlet_trx,
        outlet_tanpa_trx: outletTanpaTrx,
        total_trx: trxAgg.total_trx,
        total_revenue: trxAgg.total_revenue,
        total_margin: trxAgg.total_margin,
        avg_trx_per_active_outlet: trxAgg.active_outlet_trx ? +(trxAgg.total_trx / trxAgg.active_outlet_trx).toFixed(2) : 0,
        avg_revenue_per_trx: trxAgg.total_trx ? +(trxAgg.total_revenue / trxAgg.total_trx).toFixed(2) : 0,
        active_rate,
      },
      growth: hasPrevBulan ? {
        bulan_pembanding: prevBulan,
        trx_growth_pct: growthPct(trxAgg.total_trx, prevTrxAgg.total_trx),
        revenue_growth_pct: growthPct(trxAgg.total_revenue, prevTrxAgg.total_revenue),
        active_outlet_growth_pct: growthPct(trxAgg.active_outlet_trx, prevTrxAgg.active_outlet_trx),
      } : null,
    };

    // ── Funnel ─────────────────────────────────────────────────────────
    const funnel = {
      steps: [
        { step: 'outlet_registered', count: outlet_registered },
        { step: 'qris_terbit', count: qrisStatus.terbit },
        { step: 'active_trx', count: trxAgg.active_outlet_trx },
      ],
      rates: {
        registered_to_terbit_pct: qris_terbit_rate,
        terbit_to_active_pct: pct(trxAgg.active_outlet_trx, qrisStatus.terbit),
        registered_to_active_pct: active_rate,
      },
    };

    // ── Data quality ───────────────────────────────────────────────────
    const dataQuality = [
      { check: 'outlet_tanpa_id', count: outletBase.outlet_tanpa_id, severity: outletBase.outlet_tanpa_id > 0 ? 'warning' : 'ok' },
      { check: 'trx_tanpa_id', count: trxAgg.trx_tanpa_id, severity: trxAgg.trx_tanpa_id > 0 ? 'warning' : 'ok' },
      { check: 'qris_tanpa_id', count: qrisTanpaId, severity: qrisTanpaId > 0 ? 'warning' : 'ok' },
      { check: 'trx_tidak_match_outlet', count: trxTidakMatchOutlet, severity: trxTidakMatchOutlet > 0 ? 'warning' : 'ok' },
      { check: 'qris_status_unknown', count: qrisStatus.unknown, severity: qrisStatus.unknown > 0 ? 'warning' : 'ok' },
      { check: 'duplicate_outlet_id', count: duplicateOutletId, severity: duplicateOutletId > 0 ? 'warning' : 'ok' },
      {
        check: 'month_data_missing',
        count: [outletBase.total_rows, qrisStatus.total, trxAgg.total_rows].filter((c) => c === 0).length,
        severity: (outletBase.total_rows === 0 || qrisStatus.total === 0 || trxAgg.total_rows === 0) ? 'critical' : 'ok',
      },
    ];
    const totalIssueCount = dataQuality.reduce((s, d) => s + d.count, 0);
    const totalRecordCount = outletBase.total_rows + qrisStatus.total + trxAgg.total_rows;
    const dataQualityIssueRate = pct(totalIssueCount, totalRecordCount);

    // ── Insight / bottleneck detection (maks 5) ───────────────────────
    const insights = [];
    if (qris_terbit_rate !== null && qris_terbit_rate < THRESHOLD.QRIS_TERBIT_RATE_LOW) {
      insights.push({
        area: 'penerbitan_qris',
        title: 'Bottleneck di Penerbitan QRIS',
        detail: `Hanya ${qris_terbit_rate}% outlet terdaftar yang QRIS-nya sudah terbit (ambang batas ${THRESHOLD.QRIS_TERBIT_RATE_LOW}%).`,
        severity: 'high',
      });
    }
    const activationRate = pct(trxAgg.active_outlet_trx, qrisStatus.terbit);
    if (activationRate !== null && activationRate < THRESHOLD.ACTIVATION_RATE_LOW) {
      insights.push({
        area: 'aktivasi_transaksi',
        title: 'Bottleneck di Aktivasi / Transaksi Pertama',
        detail: `Hanya ${activationRate}% outlet ber-QRIS-terbit yang sudah bertransaksi bulan ini (ambang batas ${THRESHOLD.ACTIVATION_RATE_LOW}%).`,
        severity: 'high',
      });
    }
    if (hasPrevBulan && kpi.growth.active_outlet_growth_pct !== null && kpi.growth.active_outlet_growth_pct < 0) {
      insights.push({
        area: 'retensi',
        title: 'Outlet Aktif Menurun',
        detail: `Jumlah outlet aktif transaksi turun ${Math.abs(kpi.growth.active_outlet_growth_pct)}% dibanding ${prevBulan}.`,
        severity: 'medium',
      });
    }
    if (dataQualityIssueRate !== null && dataQualityIssueRate > THRESHOLD.DATA_QUALITY_ISSUE_RATE_HIGH) {
      insights.push({
        area: 'kualitas_data',
        title: 'Kualitas Data Perlu Perhatian',
        detail: `${dataQualityIssueRate}% dari total record kena salah satu masalah data quality (ambang batas ${THRESHOLD.DATA_QUALITY_ISSUE_RATE_HIGH}%).`,
        severity: 'medium',
      });
    }
    if (hasPrevBulan && kpi.growth.revenue_growth_pct !== null && kpi.growth.revenue_growth_pct < THRESHOLD.REVENUE_DECLINE_WARNING
        && kpi.growth.trx_growth_pct !== null && kpi.growth.trx_growth_pct > 0) {
      insights.push({
        area: 'kualitas_transaksi',
        title: 'Transaksi Naik tapi Revenue Turun',
        detail: `Jumlah transaksi naik ${kpi.growth.trx_growth_pct}% tapi revenue turun ${Math.abs(kpi.growth.revenue_growth_pct)}% dibanding ${prevBulan} — indikasi nilai transaksi mengecil.`,
        severity: 'medium',
      });
    }

    // ── Action queue summary (maks 20, agregat — bukan daftar outlet) ──
    const actionSummary = [];
    if (outletBase.outlet_tanpa_id > 0) {
      actionSummary.push({ priority: 'P0', category: 'data_quality', action_type: 'outlet_tanpa_id', count: outletBase.outlet_tanpa_id, recommendation: 'Perbaiki header/isi kolom ID Outlet di sheet sumber.' });
    }
    if (trxAgg.trx_tanpa_id > 0) {
      actionSummary.push({ priority: 'P0', category: 'data_quality', action_type: 'trx_tanpa_id', count: trxAgg.trx_tanpa_id, recommendation: 'Transaksi tanpa ID outlet tidak bisa dihubungkan ke merchant — cek sumber data.' });
    }
    if (trxTidakMatchOutlet > 0) {
      actionSummary.push({ priority: 'P0', category: 'data_quality', action_type: 'trx_tidak_match_outlet', count: trxTidakMatchOutlet, recommendation: 'Transaksi dengan ID outlet yang tidak ada di katalog outlet bulan ini — cek sinkronisasi outlet.' });
    }
    if (qrisStatus.unknown > 0) {
      actionSummary.push({ priority: 'P0', category: 'data_quality', action_type: 'qris_status_unknown', count: qrisStatus.unknown, recommendation: 'Status QRIS kosong/tidak terbaca — cek kolom status di sheet KYCKYM/PTEN.' });
    }
    if (terbitTanpaTrx > 0) {
      actionSummary.push({ priority: 'P1', category: 'aktivasi', action_type: 'qris_terbit_tanpa_transaksi', count: terbitTanpaTrx, recommendation: 'Outlet sudah punya QRIS terbit tapi belum transaksi — follow up edukasi penggunaan QRIS.' });
    }
    if (qrisStatus.belum_terbit > 0) {
      actionSummary.push({ priority: 'P2', category: 'penerbitan', action_type: 'qris_belum_terbit', count: qrisStatus.belum_terbit, recommendation: 'Kejar proses penerbitan QRIS yang masih pending/menunggu.' });
    }
    if (qrisStatus.perbaikan_data > 0) {
      actionSummary.push({ priority: 'P2', category: 'penerbitan', action_type: 'qris_perbaikan_data', count: qrisStatus.perbaikan_data, recommendation: 'Hubungi outlet untuk lengkapi/perbaiki data yang diminta.' });
    }
    if (qrisStatus.rejected > 0) {
      actionSummary.push({ priority: 'P2', category: 'penerbitan', action_type: 'qris_rejected', count: qrisStatus.rejected, recommendation: 'Registrasi ditolak — evaluasi apakah bisa didaftarkan ulang.' });
    }
    if (hasPrevBulan && churnedFromPrevMonth > 0) {
      actionSummary.push({ priority: 'P3', category: 'retensi', action_type: 'churn_dari_bulan_lalu', count: churnedFromPrevMonth, recommendation: `Outlet transaksi di ${prevBulan} tapi tidak di ${bulan} — follow up reaktivasi.` });
    }
    if (topPerformerCount > 0) {
      actionSummary.push({ priority: 'P4', category: 'growth', action_type: 'top_performer_p90_revenue', count: topPerformerCount, recommendation: 'Kandidat program reward/testimoni — revenue termasuk 10% teratas.' });
    }
    const action_summary = actionSummary.slice(0, 20);

    // ── Health status ──────────────────────────────────────────────────
    let health = 'healthy';
    const healthReasons = [];
    if (active_rate !== null && active_rate < THRESHOLD.ACTIVE_RATE_CRITICAL) {
      health = 'critical';
      healthReasons.push(`Outlet aktif transaksi hanya ${active_rate}% dari total terdaftar.`);
    } else if (dataQualityIssueRate !== null && dataQualityIssueRate > THRESHOLD.DATA_QUALITY_ISSUE_RATE_HIGH * 2) {
      health = 'critical';
      healthReasons.push(`Data quality issue rate ${dataQualityIssueRate}% — jauh di atas ambang batas.`);
    } else if (
      (qris_terbit_rate !== null && qris_terbit_rate < THRESHOLD.QRIS_TERBIT_RATE_LOW)
      || (hasPrevBulan && kpi.growth.revenue_growth_pct !== null && kpi.growth.revenue_growth_pct < THRESHOLD.REVENUE_DECLINE_WARNING)
      || (dataQualityIssueRate !== null && dataQualityIssueRate > THRESHOLD.DATA_QUALITY_ISSUE_RATE_HIGH)
    ) {
      health = 'warning';
      healthReasons.push('Salah satu indikator utama (penerbitan QRIS / revenue growth / data quality) di bawah ambang batas sehat.');
    }

    res.json({
      meta: {
        bulan,
        bulan_list: bulanList,
        bulan_pembanding: hasPrevBulan ? prevBulan : null,
        data_sources: {
          outlet: { last_synced: lastSyncedOutlet.rows[0]?.t || null },
          qris: { last_synced: lastSyncedQris.rows[0]?.t || null },
          trx: { last_synced: lastSyncedTrx.rows[0]?.t || null },
        },
      },
      kpi,
      funnel,
      insights: insights.slice(0, 5),
      action_summary,
      data_quality: {
        checks: dataQuality,
        total_issue_count: totalIssueCount,
        issue_rate_pct: dataQualityIssueRate,
      },
      health: { status: health, reasons: healthReasons },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  monthsHandler,
  analyticsHandler,
  // Diekspos untuk keperluan test manual (backend/scripts/test-*.js), bukan dipakai router.
  _internal: { bucketQrisStatus, pickSql, numericSql, prevBulanStr, THRESHOLD },
};
