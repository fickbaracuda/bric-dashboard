const express = require('express');
const router  = express.Router();
const pool    = require('../db');

const SYNC_TOKEN = 'bric2026bimasaktisecret';

// ── Sync (token auth, no JWT) ──────────────────────────────────────────────
async function syncHandler(req, res) {
  const token = req.headers['x-sync-token'] || req.body?.token;
  if (token !== SYNC_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const { bulan, d1, d2, d3 } = req.body;
  if (!bulan) return res.status(400).json({ error: 'bulan wajib ada (YYYY-MM)' });

  const t0 = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM hunter_d1 WHERE bulan=$1', [bulan]);
    await client.query('DELETE FROM hunter_d2 WHERE bulan=$1', [bulan]);
    await client.query('DELETE FROM hunter_d3 WHERE bulan=$1', [bulan]);

    if (Array.isArray(d1) && d1.length > 0) {
      await client.query(`
        INSERT INTO hunter_d1
          (bulan,upline,id_loket,nama,no_telp,type_loket,saldo,status,kota,propinsi,tgl_reg,trx,rev_trx,rev_act)
        SELECT $1,
          NULLIF(r->>'Upline',''),
          NULLIF(r->>'ID Loket',''),
          r->>'Nama', r->>'No Telp', r->>'Type Loket',
          COALESCE(NULLIF(r->>'Saldo','')::numeric, 0),
          r->>'Status', r->>'Kota', r->>'Propinsi',
          NULLIF(NULLIF(r->>'Tgl Reg',''),'0')::date,
          COALESCE(NULLIF(r->>'Trx','')::numeric, 0)::bigint,
          COALESCE(NULLIF(r->>'Rev Trx','')::numeric, 0),
          COALESCE(NULLIF(r->>'Rev Act','')::numeric, 0)
        FROM jsonb_array_elements($2::jsonb) r
        WHERE NULLIF(r->>'ID Loket','') IS NOT NULL
      `, [bulan, JSON.stringify(d1)]);
    }

    if (Array.isArray(d2) && d2.length > 0) {
      await client.query(`
        INSERT INTO hunter_d2 (bulan,id_outlet,jml_trx,margin)
        SELECT $1,
          NULLIF(r->>'id_outlet',''),
          COALESCE(NULLIF(r->>'jml_trx','')::numeric, 0)::bigint,
          COALESCE(NULLIF(r->>'margin','')::numeric, 0)
        FROM jsonb_array_elements($2::jsonb) r
        WHERE NULLIF(r->>'id_outlet','') IS NOT NULL
      `, [bulan, JSON.stringify(d2)]);
    }

    if (Array.isArray(d3) && d3.length > 0) {
      await client.query(`
        INSERT INTO hunter_d3
          (bulan,id_aktifasi,id_outlet,nama_group,nama_pemilik,is_active,upline,
           pembayaran_via,biaya_aktifasi,tipe_outlet,id_tipe_outlet,
           biaya_aktifasi_2,hpp,ongkos_kirim,fee_upline,komisi_aktifasi)
        SELECT $1,
          NULLIF(r->>'id_aktifasi','')::bigint,
          NULLIF(r->>'id_outlet',''),
          r->>'nama_group', r->>'nama_pemilik',
          COALESCE(NULLIF(r->>'is_active','')::smallint, 0),
          r->>'upline', r->>'pembayaran_via',
          COALESCE(NULLIF(r->>'biaya_aktifasi','')::numeric, 0),
          r->>'tipe_outlet',
          NULLIF(r->>'id_tipe_outlet','')::integer,
          COALESCE(NULLIF(r->>'biaya_aktifasi-2','')::numeric, 0),
          COALESCE(NULLIF(r->>'hpp','')::numeric, 0),
          COALESCE(NULLIF(r->>'ongkos_kirim','')::numeric, 0),
          COALESCE(NULLIF(r->>'fee_upline','')::numeric, 0),
          COALESCE(NULLIF(r->>'komisi_aktifasi','')::numeric, 0)
        FROM jsonb_array_elements($2::jsonb) r
        WHERE NULLIF(r->>'id_outlet','') IS NOT NULL
      `, [bulan, JSON.stringify(d3)]);
    }

    await client.query('COMMIT');
    res.json({
      ok: true, bulan,
      d1_rows: d1?.length || 0,
      d2_rows: d2?.length || 0,
      d3_rows: d3?.length || 0,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[hunter sync]', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
}

// ── Analytics ─────────────────────────────────────────────────────────────
async function analyticsHandler(req, res) {
  let { bulan } = req.query;
  try {
    const blRes = await pool.query('SELECT DISTINCT bulan FROM hunter_d1 ORDER BY bulan DESC');
    const bulanList = blRes.rows.map(r => r.bulan);
    if (!bulanList.length) return res.json({ empty: true, bulan_list: [] });
    if (!bulan) bulan = bulanList[0];

    const [d1Res, d2Res, d3Res] = await Promise.all([
      pool.query('SELECT * FROM hunter_d1 WHERE bulan=$1', [bulan]),
      pool.query('SELECT * FROM hunter_d2 WHERE bulan=$1', [bulan]),
      pool.query('SELECT * FROM hunter_d3 WHERE bulan=$1', [bulan]),
    ]);

    const result = compute(d1Res.rows, d2Res.rows, d3Res.rows);
    result.bulan      = bulan;
    result.bulan_list = bulanList;
    res.json(result);
  } catch (e) {
    console.error('[hunter analytics]', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── Business logic ────────────────────────────────────────────────────────
function n(v) { return parseFloat(v) || 0; }
function ii(v) { return parseInt(v) || 0; }

function compute(d1Rows, d2Rows, d3Rows) {
  const d2Map = new Map();
  for (const r of d2Rows) if (r.id_outlet) d2Map.set(r.id_outlet, r);

  const d3Map = new Map();
  for (const r of d3Rows) if (r.id_outlet) d3Map.set(r.id_outlet, r);

  const master = d1Rows.map(d1 => {
    const d2 = d2Map.get(d1.id_loket) || {};
    const d3 = d3Map.get(d1.id_loket) || {};

    const jml_trx    = Math.max(ii(d2.jml_trx), ii(d1.trx));
    const margin     = n(d2.margin);
    const is_act     = !!(d3.id_aktifasi && ii(d3.is_active) === 1);
    const komisi     = n(d3.komisi_aktifasi);
    const total_rev  = margin + komisi;
    const aging      = d1.tgl_reg
      ? Math.floor((Date.now() - new Date(d1.tgl_reg)) / 86400000) : 0;

    let stage;
    if (!is_act)         stage = 'registered_not_activated';
    else if (jml_trx===0) stage = 'activated_no_trx';
    else if (komisi < 0)  stage = 'activation_loss';
    else if (jml_trx===1) stage = 'first_trx';
    else if (jml_trx < 10) stage = 'low_frequency';
    else if (margin > 5000000) stage = 'revenue_hero';
    else                  stage = 'high_potential';

    return {
      upline:    d1.upline || '-',
      id_loket:  d1.id_loket,
      nama:      d1.nama || '',
      no_telp:   d1.no_telp || '',
      type_loket: d1.type_loket || n(d3.tipe_outlet) || '-',
      kota:      d1.kota || '',
      propinsi:  d1.propinsi || '',
      tgl_reg:   d1.tgl_reg,
      aging,
      jml_trx, margin, is_act, komisi,
      id_aktifasi: d3.id_aktifasi || null,
      biaya_aktifasi: n(d3.biaya_aktifasi),
      hpp:        n(d3.hpp),
      ongkos_kirim: n(d3.ongkos_kirim),
      fee_upline: n(d3.fee_upline),
      stage, total_rev,
    };
  });

  // ── Command Center ────────────────────────────────────────────────────
  const totalReg   = master.length;
  const totalAkt   = master.filter(m => m.is_act).length;
  const belumAkt   = master.filter(m => !m.is_act).length;
  const sudahTrx   = master.filter(m => m.jml_trx > 0).length;
  const outlet0Trx = master.filter(m => m.is_act && m.jml_trx === 0).length;
  const repeatTrx  = master.filter(m => m.jml_trx > 1).length;
  const revPos     = master.filter(m => m.total_rev > 0).length;
  const totalTrx   = master.reduce((s, m) => s + m.jml_trx, 0);
  const totalMgn   = master.reduce((s, m) => s + m.margin, 0);
  const netKomisi  = master.reduce((s, m) => s + m.komisi, 0);
  const totalRev   = totalMgn + netKomisi;
  const actRate    = totalReg > 0 ? totalAkt / totalReg : 0;
  const trxRate    = totalAkt > 0 ? sudahTrx / totalAkt : 0;
  const avgMgn     = totalTrx > 0 ? totalMgn / totalTrx : 0;
  const negAktCnt  = master.filter(m => m.komisi < 0).length;
  const hunterSet  = new Set(master.map(m => m.upline));

  // ── Hunter Leaderboard ────────────────────────────────────────────────
  const hMap = new Map();
  for (const m of master) {
    const k = m.upline;
    if (!hMap.has(k)) hMap.set(k, { upline: k, reg:0, akt:0, trx_out:0, total_trx:0, margin:0, rev_akt:0, neg_k:0 });
    const h = hMap.get(k);
    h.reg++;
    if (m.is_act) { h.akt++; h.rev_akt += m.komisi; }
    if (m.jml_trx > 0) { h.trx_out++; h.total_trx += m.jml_trx; }
    h.margin += m.margin;
    if (m.komisi < 0) h.neg_k++;
  }

  const hList = Array.from(hMap.values()).map(h => ({
    ...h,
    act_rate:  h.reg > 0     ? h.akt / h.reg : 0,
    trx_rate:  h.akt > 0     ? h.trx_out / h.akt : 0,
    total_rev: h.margin + h.rev_akt,
    avg_rev:   h.reg > 0     ? (h.margin + h.rev_akt) / h.reg : 0,
    avg_trx:   h.trx_out > 0 ? h.total_trx / h.trx_out : 0,
  }));

  const maxReg = Math.max(...hList.map(h => h.reg), 1);
  const maxAkt = Math.max(...hList.map(h => h.akt), 1);
  const maxTO  = Math.max(...hList.map(h => h.trx_out), 1);
  const maxRev = Math.max(...hList.map(h => h.total_rev), 1);

  for (const h of hList) {
    const sR = (h.reg / maxReg) * 100;
    const sA = (h.akt / maxAkt) * 100;
    const sT = (h.trx_out / maxTO) * 100;
    const sV = Math.max(0, h.total_rev / maxRev) * 100;
    const sC = h.trx_out > 0 ? Math.min(100, (h.total_trx / h.trx_out) / 5 * 100) : 0;
    h.score  = Math.round(0.20*sR + 0.25*sA + 0.25*sT + 0.20*sV + 0.10*sC);

    const negR = h.akt > 0 ? h.neg_k / h.akt : 0;
    if (negR > 0.3)                                         h.status = 'costly_hunter';
    else if (h.reg < 3)                                     h.status = 'dormant_hunter';
    else if (h.act_rate>=0.5 && h.trx_rate>=0.3 && h.total_rev>0) h.status = 'super_hunter';
    else if (h.act_rate>=0.4 && h.trx_rate<0.2)            h.status = 'activation_hunter';
    else if (h.reg>=5 && h.act_rate<0.3)                   h.status = 'acquisition_hunter';
    else if (h.total_rev>0 && h.reg<5)                     h.status = 'revenue_hunter';
    else                                                    h.status = 'acquisition_hunter';
  }

  hList.sort((a, b) => b.score - a.score);
  hList.forEach((h, i) => { h.rank = i + 1; });
  const scoreMap = new Map(hList.map(h => [h.upline, h.score]));

  // ── Action Queue ──────────────────────────────────────────────────────
  const STAGE_W = { registered_not_activated:100, activated_no_trx:80, activation_loss:70, first_trx:40, low_frequency:20 };
  const TYPE_W  = { 'JUARA':80,'LIMITED EDITION':60,'EDC SAKU MGM':50,'REGULER DIRECT':40,'REGULER':30,'LIMITED AM':20,'REGULER AM':20 };
  const ACTION  = { registered_not_activated:'Follow-up Aktivasi', activated_no_trx:'Dorong Transaksi Pertama', first_trx:'Dorong Repeat Transaksi', activation_loss:'Audit Biaya Aktivasi', low_frequency:'Dorong Frekuensi' };

  const queue = master
    .filter(m => STAGE_W[m.stage] !== undefined)
    .map(m => {
      const sw = STAGE_W[m.stage];
      const aw = Math.min(100, m.aging * 3);
      const hw = scoreMap.get(m.upline) || 0;
      const tw = TYPE_W[m.type_loket] || 20;
      const dw = (m.no_telp ? 50 : 0) + (m.kota || m.propinsi ? 50 : 0);
      return {
        ...m,
        priority: Math.round(0.40*sw + 0.25*aw + 0.20*hw + 0.10*tw + 0.05*dw),
        action: ACTION[m.stage] || 'Monitor',
      };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 300);

  // ── Funnel per hunter ─────────────────────────────────────────────────
  const funnelHunter = hList.map(h => {
    const my = master.filter(m => m.upline === h.upline);
    const rr = my.length;
    const aa = my.filter(m => m.is_act).length;
    const tt = my.filter(m => m.jml_trx > 0).length;
    let bot = 'OK';
    if (aa / Math.max(rr, 1) < 0.3)         bot = 'Closing Aktivasi';
    else if (tt / Math.max(aa, 1) < 0.3)    bot = 'Edukasi Penggunaan';
    else if (h.margin < 100000 && tt > 0)   bot = 'Kualitas Transaksi';
    else if (h.rev_akt < 0)                 bot = 'Struktur Biaya';
    return { upline: h.upline, rr, aa, drop_ra: rr-aa, tt, drop_at: aa-tt, rev: h.total_rev, bot, score: h.score };
  });

  // ── Revenue Intelligence ──────────────────────────────────────────────
  const aktRows = master.filter(m => m.id_aktifasi);
  const gross   = aktRows.reduce((s, m) => s + m.biaya_aktifasi, 0);
  const hpp     = aktRows.reduce((s, m) => s + m.hpp, 0);
  const ongkir  = aktRows.reduce((s, m) => s + m.ongkos_kirim, 0);
  const feeUp   = aktRows.reduce((s, m) => s + m.fee_upline, 0);
  const lossRows = aktRows
    .filter(m => m.komisi < 0)
    .sort((a, b) => a.komisi - b.komisi)
    .slice(0, 50);

  // ── Area & Type ───────────────────────────────────────────────────────
  const propMap = new Map();
  const typeMap = new Map();
  for (const m of master) {
    const pk = m.propinsi || '-';
    if (!propMap.has(pk)) propMap.set(pk, { propinsi:pk, reg:0, akt:0, trx:0, jml_trx:0, margin:0, rev_akt:0 });
    const p = propMap.get(pk);
    p.reg++;
    if (m.is_act) p.akt++;
    if (m.jml_trx > 0) { p.trx++; p.jml_trx += m.jml_trx; }
    p.margin += m.margin;
    p.rev_akt += m.komisi;

    const tk = m.type_loket || '-';
    if (!typeMap.has(tk)) typeMap.set(tk, { type_loket:tk, reg:0, akt:0, trx:0, jml_trx:0, margin:0, gross_akt:0, net_akt:0 });
    const t = typeMap.get(tk);
    t.reg++;
    if (m.is_act) t.akt++;
    if (m.jml_trx > 0) { t.trx++; t.jml_trx += m.jml_trx; }
    t.margin += m.margin;
    t.gross_akt += m.biaya_aktifasi;
    t.net_akt += m.komisi;
  }

  const areaData = Array.from(propMap.values())
    .map(p => ({ ...p, total_rev: p.margin+p.rev_akt, act_rate: p.reg>0 ? p.akt/p.reg : 0 }))
    .sort((a, b) => b.reg - a.reg);

  const typeData = Array.from(typeMap.values())
    .map(t => ({ ...t, total_rev: t.margin+t.net_akt, avg_rev: t.reg>0 ? (t.margin+t.net_akt)/t.reg : 0 }))
    .sort((a, b) => b.reg - a.reg);

  return {
    command_center: {
      total_hunters: hunterSet.size,
      total_register: totalReg,
      total_aktivasi: totalAkt,
      belum_aktivasi: belumAkt,
      sudah_trx: sudahTrx,
      outlet_0_trx: outlet0Trx,
      repeat_trx: repeatTrx,
      rev_positive: revPos,
      total_trx: totalTrx,
      total_margin: totalMgn,
      rev_aktivasi_net: netKomisi,
      total_revenue: totalRev,
      activation_rate: actRate,
      first_trx_rate: trxRate,
      avg_margin_per_trx: avgMgn,
      neg_activation_count: negAktCnt,
      funnel: { register: totalReg, aktivasi: totalAkt, trx: sudahTrx, repeat: repeatTrx, rev_positive: revPos },
    },
    hunter_leaderboard: hList,
    action_queue: queue,
    funnel_hunter: funnelHunter,
    revenue: {
      gross_aktivasi: gross,
      hpp_total: hpp,
      ongkos_kirim_total: ongkir,
      fee_upline_total: feeUp,
      net_komisi: netKomisi,
      margin_trx: totalMgn,
      total_net_revenue: totalRev,
      loss_count: negAktCnt,
      loss_amount: lossRows.reduce((s, m) => s + m.komisi, 0),
      loss_table: lossRows,
    },
    area: areaData,
    type_loket: typeData,
    meta: {
      hunters: hList.map(h => h.upline),
      provinces: [...new Set(master.map(m => m.propinsi).filter(Boolean))].sort(),
      types: [...new Set(master.map(m => m.type_loket).filter(Boolean))].sort(),
    },
  };
}

router.get('/analytics', analyticsHandler);

module.exports = router;
module.exports.syncHandler      = syncHandler;
module.exports.analyticsHandler = analyticsHandler;
