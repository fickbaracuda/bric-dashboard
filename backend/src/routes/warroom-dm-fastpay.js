const pool = require('../db');

const SYNC_TOKEN = 'bric2026bimasaktisecret';

function n(v) {
  if (v === null || v === undefined || v === '') return 0;
  const num = Number(v);
  return isNaN(num) ? 0 : num;
}

/* ── POST /api/warroom/dm-fastpay/sync ── token auth, no JWT */
async function syncHandler(req, res) {
  const token = req.headers['x-sync-token'] || req.body?.token;
  if (token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const { tanggal, data } = req.body;
  if (!tanggal || !data) return res.status(400).json({ error: 'tanggal and data required' });

  try {
    await pool.query(`
      INSERT INTO dm_fastpay_snapshot (
        tanggal,
        rev_target, rev_actual, rev_progress,
        nmat_target, nmat_actual, nmat_progress,
        app_google_budget, app_google_impression, app_google_cpm, app_google_install, app_google_cpi,
        app_tiktok_budget, app_tiktok_impression, app_tiktok_cpm, app_tiktok_install, app_tiktok_cpi,
        ret_google_budget, ret_google_impression, ret_google_cpm, ret_google_action, ret_google_cpa,
        ret_tiktok_budget, ret_tiktok_impression, ret_tiktok_cpm, ret_tiktok_action, ret_tiktok_cpa,
        brand_target, brand_actual, brand_progress,
        reg_direct, reg_direct_cpa, akt_direct, akt_direct_cpa, konversi,
        nmat_jawa_target, nmat_jawa_actual, nmat_jawa_progress,
        roi, rev_trx_direct,
        meta_budget, meta_impression, meta_cpm, meta_klik, meta_hasil, meta_biaya_hasil,
        konten_official, konten_kol, konten_paid_ads,
        synced_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
        $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
        $41,$42,$43,$44,$45,$46,$47,$48,$49,NOW()
      )
      ON CONFLICT (tanggal) DO UPDATE SET
        rev_target=EXCLUDED.rev_target, rev_actual=EXCLUDED.rev_actual, rev_progress=EXCLUDED.rev_progress,
        nmat_target=EXCLUDED.nmat_target, nmat_actual=EXCLUDED.nmat_actual, nmat_progress=EXCLUDED.nmat_progress,
        app_google_budget=EXCLUDED.app_google_budget, app_google_impression=EXCLUDED.app_google_impression,
        app_google_cpm=EXCLUDED.app_google_cpm, app_google_install=EXCLUDED.app_google_install,
        app_google_cpi=EXCLUDED.app_google_cpi,
        app_tiktok_budget=EXCLUDED.app_tiktok_budget, app_tiktok_impression=EXCLUDED.app_tiktok_impression,
        app_tiktok_cpm=EXCLUDED.app_tiktok_cpm, app_tiktok_install=EXCLUDED.app_tiktok_install,
        app_tiktok_cpi=EXCLUDED.app_tiktok_cpi,
        ret_google_budget=EXCLUDED.ret_google_budget, ret_google_impression=EXCLUDED.ret_google_impression,
        ret_google_cpm=EXCLUDED.ret_google_cpm, ret_google_action=EXCLUDED.ret_google_action,
        ret_google_cpa=EXCLUDED.ret_google_cpa,
        ret_tiktok_budget=EXCLUDED.ret_tiktok_budget, ret_tiktok_impression=EXCLUDED.ret_tiktok_impression,
        ret_tiktok_cpm=EXCLUDED.ret_tiktok_cpm, ret_tiktok_action=EXCLUDED.ret_tiktok_action,
        ret_tiktok_cpa=EXCLUDED.ret_tiktok_cpa,
        brand_target=EXCLUDED.brand_target, brand_actual=EXCLUDED.brand_actual, brand_progress=EXCLUDED.brand_progress,
        reg_direct=EXCLUDED.reg_direct, reg_direct_cpa=EXCLUDED.reg_direct_cpa,
        akt_direct=EXCLUDED.akt_direct, akt_direct_cpa=EXCLUDED.akt_direct_cpa, konversi=EXCLUDED.konversi,
        nmat_jawa_target=EXCLUDED.nmat_jawa_target, nmat_jawa_actual=EXCLUDED.nmat_jawa_actual,
        nmat_jawa_progress=EXCLUDED.nmat_jawa_progress,
        roi=EXCLUDED.roi, rev_trx_direct=EXCLUDED.rev_trx_direct,
        meta_budget=EXCLUDED.meta_budget, meta_impression=EXCLUDED.meta_impression,
        meta_cpm=EXCLUDED.meta_cpm, meta_klik=EXCLUDED.meta_klik,
        meta_hasil=EXCLUDED.meta_hasil, meta_biaya_hasil=EXCLUDED.meta_biaya_hasil,
        konten_official=EXCLUDED.konten_official, konten_kol=EXCLUDED.konten_kol,
        konten_paid_ads=EXCLUDED.konten_paid_ads,
        synced_at=NOW()
    `, [
      tanggal,
      n(data.rev_target),    n(data.rev_actual),    n(data.rev_progress),
      n(data.nmat_target),   n(data.nmat_actual),   n(data.nmat_progress),
      n(data.app_google_budget), n(data.app_google_impression), n(data.app_google_cpm),
      n(data.app_google_install), n(data.app_google_cpi),
      n(data.app_tiktok_budget), n(data.app_tiktok_impression), n(data.app_tiktok_cpm),
      n(data.app_tiktok_install), n(data.app_tiktok_cpi),
      n(data.ret_google_budget), n(data.ret_google_impression), n(data.ret_google_cpm),
      n(data.ret_google_action), n(data.ret_google_cpa),
      n(data.ret_tiktok_budget), n(data.ret_tiktok_impression), n(data.ret_tiktok_cpm),
      n(data.ret_tiktok_action), n(data.ret_tiktok_cpa),
      n(data.brand_target),  n(data.brand_actual),  n(data.brand_progress),
      n(data.reg_direct),    n(data.reg_direct_cpa),
      n(data.akt_direct),    n(data.akt_direct_cpa), n(data.konversi),
      n(data.nmat_jawa_target), n(data.nmat_jawa_actual), n(data.nmat_jawa_progress),
      n(data.roi),           n(data.rev_trx_direct),
      n(data.meta_budget),   n(data.meta_impression), n(data.meta_cpm),
      n(data.meta_klik),     n(data.meta_hasil),     n(data.meta_biaya_hasil),
      n(data.konten_official), n(data.konten_kol),   n(data.konten_paid_ads),
    ]);

    res.json({ ok: true, tanggal });
  } catch (err) {
    console.error('DM Fastpay sync error:', err);
    res.status(500).json({ error: err.message });
  }
}

/* ── GET /api/warroom/dm-fastpay/analytics ── */
async function analyticsHandler(req, res) {
  try {
    const { tanggal } = req.query;
    let tgl = tanggal;

    if (!tgl) {
      const r = await pool.query('SELECT MAX(tanggal) AS t FROM dm_fastpay_snapshot');
      tgl = r.rows[0]?.t;
    }
    if (!tgl) return res.json({ tanggal: null, data: null, tanggal_list: [] });

    const [dataRes, listRes] = await Promise.all([
      pool.query('SELECT * FROM dm_fastpay_snapshot WHERE tanggal = $1', [tgl]),
      pool.query('SELECT DISTINCT tanggal FROM dm_fastpay_snapshot ORDER BY tanggal DESC LIMIT 60'),
    ]);

    res.json({
      tanggal: tgl,
      data: dataRes.rows[0] || null,
      tanggal_list: listRes.rows.map(r => r.tanggal),
    });
  } catch (err) {
    console.error('DM Fastpay analytics error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { syncHandler, analyticsHandler };
