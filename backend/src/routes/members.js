const express = require('express');
const router  = express.Router();
const pool    = require('../db');

function getInisial(nama) {
  const w = nama.trim().split(' ');
  return w.length >= 2
    ? (w[0][0] + w[1][0]).toUpperCase()
    : nama.substring(0, 2).toUpperCase();
}

function generateRekomendasi(member, targets, avg, trend) {
  const lemah = targets.filter(t => (t.avg_pct || 0) < 80);
  let rec = '';
  if (avg >= 100)
    rec = `${member.nama} tampil luar biasa dengan rata-rata pencapaian ${avg.toFixed(1)}%. Pertahankan momentum dan dorong target lebih ambisius bulan depan.`;
  else if (avg >= 80)
    rec = `${member.nama} on-track (${avg.toFixed(1)}%). Fokus pada ${lemah.map(t => t.nama_target).join(' dan ') || 'target yang masih lemah'} untuk push ke 100%.`;
  else
    rec = `${member.nama} perlu akselerasi segera (${avg.toFixed(1)}%). Review hambatan di ${lemah.map(t => t.nama_target).join(', ') || 'semua target'} dan susun rencana aksi mingguan bersama leader.`;

  if (trend === 'naik')  rec += ' Tren 3 hari terakhir positif — momentum sedang bagus.';
  if (trend === 'turun') rec += ' Tren 3 hari terakhir menurun — perlu evaluasi penyebab perlambatan.';
  return rec;
}

/* ── GET /api/members?unit=winme_instaqris ── */
router.get('/', async (req, res) => {
  const { unit = 'winme_instaqris' } = req.query;
  try {
    const result = await pool.query(`
      SELECT
        m.*,
        COALESCE(
          json_agg(
            json_build_object(
              'id',                  t.id,
              'nama_target',         t.nama_target,
              'key_result',          t.key_result,
              'target_revenue',      t.target_revenue,
              'periode',             t.periode,
              'urutan',              t.urutan,
              'pencapaian_terakhir', (
                SELECT row_to_json(p)
                FROM member_pencapaian p
                WHERE p.target_id = t.id
                ORDER BY p.tanggal DESC LIMIT 1
              )
            ) ORDER BY t.urutan
          ) FILTER (WHERE t.id IS NOT NULL),
          '[]'
        ) AS targets
      FROM members m
      LEFT JOIN member_targets t ON t.member_id = m.id
      WHERE m.unit = $1 AND m.is_active = TRUE
      GROUP BY m.id
      ORDER BY
        CASE m.posisi WHEN 'leader' THEN 0 ELSE 1 END,
        m.created_at ASC
    `, [unit]);
    res.json(result.rows);
  } catch (err) {
    console.error('GET members error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /api/members/:id/detail ── */
router.get('/:id/detail', async (req, res) => {
  const { id } = req.params;
  try {
    const memberRes = await pool.query(
      'SELECT * FROM members WHERE id = $1 AND is_active = TRUE', [id]
    );
    if (!memberRes.rows.length)
      return res.status(404).json({ error: 'Anggota tidak ditemukan.' });

    const member = memberRes.rows[0];
    const targetsRes = await pool.query(
      'SELECT * FROM member_targets WHERE member_id = $1 ORDER BY urutan', [id]
    );
    const targets = targetsRes.rows;
    const targetIds = targets.map(t => t.id);

    let riwayatMap = {};
    if (targetIds.length > 0) {
      const riwayatRes = await pool.query(`
        SELECT * FROM member_pencapaian
        WHERE target_id = ANY($1)
          AND tanggal >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY tanggal DESC
      `, [targetIds]);
      riwayatRes.rows.forEach(r => {
        if (!riwayatMap[r.target_id]) riwayatMap[r.target_id] = [];
        riwayatMap[r.target_id].push(r);
      });
    }

    const targetsWithData = targets.map(t => {
      const riwayat = riwayatMap[t.id] || [];
      const valid   = riwayat.filter(r => r.pct_revenue > 0);
      const avg_pct = valid.length
        ? valid.reduce((s, r) => s + parseFloat(r.pct_revenue), 0) / valid.length
        : 0;
      return { ...t, riwayat, avg_pct: parseFloat(avg_pct.toFixed(2)) };
    });

    const validTargets = targetsWithData.filter(t => t.avg_pct > 0);
    const avg_pencapaian = validTargets.length
      ? validTargets.reduce((s, t) => s + t.avg_pct, 0) / validTargets.length
      : 0;

    const sorted_by_pct  = [...targetsWithData].sort((a, b) => b.avg_pct - a.avg_pct);
    const target_terbaik  = sorted_by_pct[0]?.nama_target || '—';
    const target_terlemah = sorted_by_pct[sorted_by_pct.length - 1]?.nama_target || '—';

    let trend = 'stabil';
    const allRiwayat = Object.values(riwayatMap).flat()
      .sort((a, b) => new Date(b.tanggal) - new Date(a.tanggal));
    if (allRiwayat.length >= 6) {
      const avg3Baru = allRiwayat.slice(0, 3).reduce((s, r) => s + parseFloat(r.pct_revenue), 0) / 3;
      const avg3Lama = allRiwayat.slice(3, 6).reduce((s, r) => s + parseFloat(r.pct_revenue), 0) / 3;
      if (avg3Baru > avg3Lama + 2)  trend = 'naik';
      if (avg3Baru < avg3Lama - 2)  trend = 'turun';
    }

    const rekomendasi = generateRekomendasi(
      member, targetsWithData, parseFloat(avg_pencapaian.toFixed(2)), trend
    );

    res.json({
      member,
      targets: targetsWithData,
      analisis: {
        avg_pencapaian: parseFloat(avg_pencapaian.toFixed(2)),
        trend,
        target_terbaik,
        target_terlemah,
        rekomendasi
      }
    });
  } catch (err) {
    console.error('GET member detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/members ── */
router.post('/', async (req, res) => {
  const { nama, posisi, fungsi, avatar_warna, unit, targets = [] } = req.body;
  if (!nama || !posisi)
    return res.status(400).json({ error: 'Nama dan posisi wajib diisi.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const memberRes = await client.query(`
      INSERT INTO members (nama, posisi, fungsi, avatar_warna, unit)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [nama.trim(), posisi, fungsi || null,
        avatar_warna || '#7F77DD', unit || 'winme_instaqris']);
    const member = memberRes.rows[0];

    const insertedTargets = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t.nama_target) continue;
      const tRes = await client.query(`
        INSERT INTO member_targets
          (member_id, nama_target, key_result, target_revenue, periode, urutan)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
      `, [member.id, t.nama_target, t.key_result || null,
          parseFloat(t.target_revenue) || 0, t.periode || 'JUN_2026', i + 1]);
      insertedTargets.push(tRes.rows[0]);
    }

    await client.query('COMMIT');
    res.status(201).json({ ...member, targets: insertedTargets });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST member error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ── PUT /api/members/:id ── */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nama, posisi, fungsi, avatar_warna, is_active } = req.body;
  try {
    const result = await pool.query(`
      UPDATE members
      SET nama=$1, posisi=$2, fungsi=$3, avatar_warna=$4,
          is_active=$5, updated_at=NOW()
      WHERE id=$6 RETURNING *
    `, [nama, posisi, fungsi, avatar_warna, is_active ?? true, id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── DELETE /api/members/:id (soft delete) ── */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(
      'UPDATE members SET is_active=FALSE, updated_at=NOW() WHERE id=$1', [id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/members/:id/targets ── */
router.post('/:id/targets', async (req, res) => {
  const { id } = req.params;
  const { nama_target, key_result, target_revenue, periode } = req.body;
  if (!nama_target)
    return res.status(400).json({ error: 'Nama target wajib diisi.' });
  try {
    const countRes = await pool.query(
      'SELECT COUNT(*) FROM member_targets WHERE member_id=$1', [id]
    );
    const urutan = parseInt(countRes.rows[0].count) + 1;
    const result = await pool.query(`
      INSERT INTO member_targets
        (member_id, nama_target, key_result, target_revenue, periode, urutan)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [id, nama_target, key_result || null,
        parseFloat(target_revenue) || 0, periode || 'JUN_2026', urutan]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── DELETE /api/members/targets/:target_id ── */
router.delete('/targets/:target_id', async (req, res) => {
  const { target_id } = req.params;
  try {
    await pool.query('DELETE FROM member_targets WHERE id=$1', [target_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /api/members/targets/:target_id/pencapaian ── */
router.post('/targets/:target_id/pencapaian', async (req, res) => {
  const { target_id } = req.params;
  const { pencapaian_kr, pencapaian_revenue, pct_kr, pct_revenue, catatan, tanggal, member_id } = req.body;

  try {
    const targetRes = await pool.query(
      'SELECT * FROM member_targets WHERE id=$1', [target_id]
    );
    if (!targetRes.rows.length)
      return res.status(404).json({ error: 'Target tidak ditemukan.' });

    const target = targetRes.rows[0];
    const revAmt = parseFloat(pencapaian_revenue) || 0;
    const pctRev = target.target_revenue > 0
      ? parseFloat(((revAmt / parseFloat(target.target_revenue)) * 100).toFixed(2))
      : parseFloat(pct_revenue) || 0;
    const tglInput = tanggal || new Date().toISOString().split('T')[0];
    const mId = member_id || target.member_id;

    const result = await pool.query(`
      INSERT INTO member_pencapaian
        (member_id, target_id, tanggal, pencapaian_kr,
         pencapaian_revenue, pct_kr, pct_revenue, catatan)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (target_id, tanggal) DO UPDATE SET
        pencapaian_kr      = EXCLUDED.pencapaian_kr,
        pencapaian_revenue = EXCLUDED.pencapaian_revenue,
        pct_kr             = EXCLUDED.pct_kr,
        pct_revenue        = EXCLUDED.pct_revenue,
        catatan            = EXCLUDED.catatan
      RETURNING *
    `, [mId, target_id, tglInput, pencapaian_kr || null,
        revAmt, parseFloat(pct_kr) || 0, pctRev, catatan || null]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('POST pencapaian error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
