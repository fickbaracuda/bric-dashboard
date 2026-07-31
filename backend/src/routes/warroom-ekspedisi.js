const pool = require('../db');

// Part 2A: baca dari env dulu, fallback ke nilai lama agar Apps Script existing tidak putus.
// TODO Part 2B/2C: hapus fallback literal setelah APPS_SCRIPT_TOKEN dipastikan di-set di server.
const SECRET_TOKEN = process.env.APPS_SCRIPT_TOKEN || 'bric2026bimasaktisecret';
const MONTHS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Ags', 'Sep', 'Okt', 'Nov', 'Des'];

// Nama bulan (Indonesia + Inggris, berbagai singkatan) -> nomor bulan 1-12.
// Dipakai detectMonthGroups() saat parsing grid mentah dari sheet.
const MONTH_ALIASES = {
  JAN: 1, JANUARI: 1,
  FEB: 2, FEBRUARI: 2,
  MAR: 3, MARET: 3,
  APR: 4, APRIL: 4,
  MEI: 5, MAY: 5,
  JUN: 6, JUNI: 6, JUNE: 6,
  JUL: 7, JULI: 7, JULY: 7,
  AGU: 8, AGT: 8, AGUSTUS: 8, AUG: 8,
  SEP: 9, SEPT: 9, SEPTEMBER: 9,
  OKT: 10, OCT: 10, OKTOBER: 10,
  NOV: 11, NOVEMBER: 11,
  DES: 12, DEC: 12, DESEMBER: 12,
};

function monthLabel(bulan) {
  if (!bulan) return '-';
  const idx = parseInt(String(bulan).split('-')[1], 10) - 1;
  return MONTHS_ID[idx] || bulan;
}

function monthNameToIndex(label) {
  const key = String(label || '').trim().toUpperCase();
  return MONTH_ALIASES[key] || null;
}

function daysInMonth(bulan) {
  const [y, m] = String(bulan).split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/* ══════════════════════════════════════════════════════════════════
   PARSER — angka mentah dari sheet (comma ribuan, prefix "Rp") -> number
   parseTrx("4,532") -> 4532 | parseRevenue("Rp227,455") -> 227455
   ══════════════════════════════════════════════════════════════════ */
function parseTrx(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return Math.round(val);
  const digits = String(val).replace(/[^0-9]/g, '');
  return digits ? parseInt(digits, 10) : 0;
}
function parseRevenue(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return Math.round(val);
  const digits = String(val).replace(/[^0-9]/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

/* ══════════════════════════════════════════════════════════════════
   detectMonthGroups — cari field "Day" (dayCutoff) dan baris label
   bulan di grid mentah (mis. hasil sheet.getDataRange().getValues()).
   Struktur yang dicari:
     baris judul/Day (opsional, "Review Ekspedisi", "Day", <angka>)
     baris label bulan: MEI | | | JUN | | | JUL | | | ...
     baris header: ID Outlet | Trx | Revenue | ID Outlet | Trx | Revenue | ...
     baris data outlet
   Tiap grup bulan = 3 kolom, grup baru ditambah terus ke kanan — TIDAK
   dibatasi ke bulan tertentu, dibaca sampai kolom terakhir yang valid.
   ══════════════════════════════════════════════════════════════════ */
function detectMonthGroups(grid) {
  if (!Array.isArray(grid) || grid.length < 2) return { dayCutoff: null, groups: [] };

  // ── cari field "Day" di 5 baris pertama ──
  let dayCutoff = null;
  for (let r = 0; r < Math.min(grid.length, 5) && dayCutoff === null; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length - 1; c++) {
      if (String(row[c] ?? '').trim().toLowerCase() === 'day') {
        const v = Number(row[c + 1]);
        if (!Number.isNaN(v)) dayCutoff = v;
        break;
      }
    }
  }

  // ── cari baris label bulan (baris pertama yang punya >=1 cell cocok nama bulan) ──
  let labelRowIdx = -1;
  for (let r = 0; r < Math.min(grid.length, 6); r++) {
    const row = grid[r] || [];
    if (row.some(cell => monthNameToIndex(cell) !== null)) { labelRowIdx = r; break; }
  }
  if (labelRowIdx === -1) return { dayCutoff, groups: [] };

  const labelRow = grid[labelRowIdx] || [];
  const groups = [];
  for (let c = 0; c < labelRow.length; c += 3) {
    const label = String(labelRow[c] ?? '').trim();
    const monthIndex = monthNameToIndex(label);
    if (!monthIndex) continue; // skip kolom yang bukan awal grup bulan valid
    groups.push({ startCol: c, label, monthIndex, dataStartRow: labelRowIdx + 2 });
  }
  return { dayCutoff, groups };
}

/* ══════════════════════════════════════════════════════════════════
   normalizeEkspedisiRows — wide -> long. Menerima grid mentah + hasil
   detectMonthGroups(), mengembalikan array "Normalized monthly fact"
   satu baris per (idOutlet, bulan). ID Outlet kosong -> row di-skip.
   Trx/Revenue kosong -> 0 (via parseTrx/parseRevenue).
   ══════════════════════════════════════════════════════════════════ */
function normalizeEkspedisiRows(grid, groups, opts = {}) {
  const { dayCutoff = null } = opts;
  const facts = [];
  if (!Array.isArray(grid) || !groups.length) return facts;

  // Assign tahun per grup — anchor tahun berjalan ke grup PALING KANAN
  // (terbaru), mundur ke kiri. Kalau monthIndex NAIK saat mundur ke kiri
  // berarti baru saja lewat batas tahun -> tahun grup itu dikurangi 1.
  const today = new Date();
  const n = groups.length;
  const withYear = groups.map(g => ({ ...g }));
  withYear[n - 1].year = today.getFullYear();
  for (let i = n - 2; i >= 0; i--) {
    withYear[i].year = withYear[i].monthIndex > withYear[i + 1].monthIndex
      ? withYear[i + 1].year - 1
      : withYear[i + 1].year;
  }
  withYear.forEach((g, i) => {
    g.monthOrder = i + 1;
    g.bulan = `${g.year}-${String(g.monthIndex).padStart(2, '0')}`;
  });

  const dataStart = Math.min(...withYear.map(g => g.dataStartRow));
  for (let r = dataStart; r < grid.length; r++) {
    const row = grid[r] || [];
    for (const g of withYear) {
      const idOutlet = String(row[g.startCol] ?? '').trim();
      if (!idOutlet) continue; // ID Outlet wajib ada agar row valid
      const trx = parseTrx(row[g.startCol + 1]);
      const revenue = parseRevenue(row[g.startCol + 2]);
      facts.push({
        idOutlet,
        monthLabel: g.label,
        monthIndex: g.monthIndex,
        monthOrder: g.monthOrder,
        trx,
        revenue,
        avgRevenuePerTrx: trx > 0 ? revenue / trx : 0,
        dayCutoff: g.monthOrder === n ? dayCutoff : null, // cutoff cuma relevan utk bulan terakhir/current
        sourceRow: r,
      });
    }
  }
  return facts;
}

/* ══════════════════════════════════════════════════════════════════
   Statistik kecil — percentile & median (dipakai untuk klasifikasi
   whale / low-yield / premium-yield).
   ══════════════════════════════════════════════════════════════════ */
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* ══════════════════════════════════════════════════════════════════
   aggregateMonthlySummary — agregat per bulan + MoM% + proyeksi EOM.
   Proyeksi HANYA dihitung untuk bulan terakhir/current (pakai dayCutoff);
   bulan yang sudah lewat dianggap final (projected = actual).
   ══════════════════════════════════════════════════════════════════ */
function aggregateMonthlySummary(bulanList, monthAgg, dayCutoff) {
  return bulanList.map((b, i) => {
    const agg = monthAgg[b] || { totalTrx: 0, totalRevenue: 0, activeOutlets: 0 };
    const prevB = i > 0 ? bulanList[i - 1] : null;
    const prevAgg = prevB ? monthAgg[prevB] : null;
    const isCurrent = i === bulanList.length - 1;

    let projectedEomTrx = agg.totalTrx;
    let projectedEomRevenue = agg.totalRevenue;
    if (isCurrent && dayCutoff) {
      const dim = daysInMonth(b);
      projectedEomTrx = agg.totalTrx / dayCutoff * dim;
      projectedEomRevenue = agg.totalRevenue / dayCutoff * dim;
    }

    return {
      bulan: b,
      monthLabel: monthLabel(b),
      monthIndex: parseInt(b.split('-')[1], 10),
      monthOrder: i + 1,
      totalTrx: agg.totalTrx,
      totalRevenue: agg.totalRevenue,
      activeOutlets: agg.activeOutlets,
      avgTrxPerOutlet: agg.activeOutlets > 0 ? agg.totalTrx / agg.activeOutlets : 0,
      avgRevenuePerOutlet: agg.activeOutlets > 0 ? agg.totalRevenue / agg.activeOutlets : 0,
      avgRevenuePerTrx: agg.totalTrx > 0 ? agg.totalRevenue / agg.totalTrx : 0,
      momTrxGrowth: prevAgg && prevAgg.totalTrx > 0 ? ((agg.totalTrx - prevAgg.totalTrx) / prevAgg.totalTrx * 100) : null,
      momRevenueGrowth: prevAgg && prevAgg.totalRevenue > 0 ? ((agg.totalRevenue - prevAgg.totalRevenue) / prevAgg.totalRevenue * 100) : null,
      momActiveOutletGrowth: prevAgg && prevAgg.activeOutlets > 0 ? ((agg.activeOutlets - prevAgg.activeOutlets) / prevAgg.activeOutlets * 100) : null,
      projectedEomTrx, projectedEomRevenue,
    };
  });
}

/* ══════════════════════════════════════════════════════════════════
   Segmentasi outlet (10 segmen) & prioritas eksekusi (P0-P3).
   Urutan pengecekan di assignSegment MENENTUKAN (first-match-wins) —
   churn/new_active dicek duluan karena keduanya kondisi definitif yang
   membuat growth% tidak terdefinisi (trxPrev=0 atau trxCurrent=0).
   "At Risk" (turun >30%) dicek sebelum "Declining" (20-50%) supaya
   rentang -30%..-50% konsisten masuk At Risk, bukan dobel-match.
   ══════════════════════════════════════════════════════════════════ */
const SEGMENT_ACTION = {
  whale:          'Maintain — jaga relasi, pastikan tidak drop.',
  growth_driver:  'Scale — dorong transaksi lebih sering, replikasi pola sukses.',
  at_risk:        'Follow-up kendala — hubungi outlet, cari tahu penyebab penurunan.',
  churn:          'Reaktivasi — hubungi outlet, cari tahu kendala kenapa berhenti transaksi.',
  new_active:     'Onboarding repeat — dorong transaksi kedua dan seterusnya.',
  one_timer:      'Dorong transaksi kedua — follow-up untuk repeat order.',
  low_yield:      'Cek margin, produk, atau pricing — revenue per transaksi di bawah median.',
  premium_yield:  'Cari pola dan scale outlet sejenis — revenue per transaksi tinggi meski volume kecil.',
  stable:         'Maintain — pertahankan performa saat ini.',
  declining:      'Follow-up ringan / campaign — tren menurun moderat, perlu perhatian.',
};

function assignSegment(o, ctx) {
  const { isWhale, medianAvgRevPerTrx, medianTrxCurrent, avgRevenuePerTrxCurrent } = ctx;
  const trxG = o.pctTrxGrowth;
  const revG = o.pctRevenueGrowth;

  if (o.trxPrev > 0 && o.trxCurrent === 0) return 'churn';
  if (o.trxPrev === 0 && o.trxCurrent > 0)  return 'new_active';
  if (o.trxCurrent === 0)                   return 'churn'; // tidak aktif di 2 bulan ini sama sekali

  if (isWhale) return 'whale';
  if (o.trxCurrent === 1) return 'one_timer';
  if ((trxG != null && trxG > 30) || (revG != null && revG > 30)) return 'growth_driver';
  if (trxG != null && trxG < -30) return 'at_risk';
  if (medianTrxCurrent > 0 && o.trxCurrent >= medianTrxCurrent && avgRevenuePerTrxCurrent < medianAvgRevPerTrx * 0.7) return 'low_yield';
  if (medianTrxCurrent > 0 && o.trxCurrent <= medianTrxCurrent && avgRevenuePerTrxCurrent > medianAvgRevPerTrx * 1.5) return 'premium_yield';
  if (trxG != null && trxG >= -20 && trxG <= 20) return 'stable';
  if (trxG != null && trxG < -20 && trxG >= -50) return 'declining';
  return 'stable'; // fallback pragmatis (mis. growth 20%-30% tidak dispesifikasikan eksplisit)
}

function assignPriority(o, segment, isWhale) {
  const trxG = o.pctTrxGrowth != null ? o.pctTrxGrowth : 0;
  const revG = o.pctRevenueGrowth != null ? o.pctRevenueGrowth : 0;

  if (segment === 'churn' && isWhale) return 'P0';
  if (trxG <= -50 || revG <= -50)     return 'P0';

  if (segment === 'churn')      return 'P1';
  if (segment === 'declining')  return 'P1';
  if (segment === 'at_risk')    return 'P1';
  if (segment === 'low_yield')  return 'P1';

  if (segment === 'new_active') return 'P2';
  if (segment === 'one_timer')  return 'P2';
  if (segment === 'growth_driver' && !isWhale) return 'P2';

  return 'P3'; // stable, whale, premium_yield, growth_driver+whale
}

function buildOutletPerformance(outletsPivot, monthlyFactsByOutlet, ctx) {
  const { trxP90, revP90, medianAvgRevPerTrx, medianTrxCurrent, bCurrent, bPrev } = ctx;

  return outletsPivot.map(o => {
    const facts = monthlyFactsByOutlet[o.idOutlet] || [];
    const activeMonthCount = facts.filter(f => f.trx > 0).length;
    const bestFact = facts.reduce((best, f) => (!best || f.revenue > best.revenue) ? f : best, null);

    const isWhale = Math.max(o.trxCurrent, o.trxPrev) >= trxP90 || Math.max(o.revenueCurrent, o.revenuePrev) >= revP90;
    const avgRevenuePerTrxCurrent = o.trxCurrent > 0 ? o.revenueCurrent / o.trxCurrent : 0;

    const segment = assignSegment(o, { isWhale, medianAvgRevPerTrx, medianTrxCurrent, avgRevenuePerTrxCurrent });
    const priority = assignPriority(o, segment, isWhale);

    return {
      idOutlet: o.idOutlet,
      months: facts.map(f => ({ monthLabel: f.monthLabel, monthIndex: f.monthIndex, monthOrder: f.monthOrder, trx: f.trx, revenue: f.revenue })),
      currentMonth: bCurrent,
      previousMonth: bPrev,
      currentTrx: o.trxCurrent,
      previousTrx: o.trxPrev,
      trxDelta: o.devTrx,
      trxGrowthPercent: o.pctTrxGrowth,
      currentRevenue: o.revenueCurrent,
      previousRevenue: o.revenuePrev,
      revenueDelta: o.devRevenue,
      revenueGrowthPercent: o.pctRevenueGrowth,
      avgRevenuePerTrx: avgRevenuePerTrxCurrent,
      activeMonthCount,
      bestMonth: bestFact ? bestFact.monthLabel : null,
      segment,
      priority,
      recommendedAction: SEGMENT_ACTION[segment] || '-',
    };
  });
}

/* ══════════════════════════════════════════════════════════════════
   generateExecutiveInsights — insight otomatis berbasis monthlySummary
   + businessMetrics + outletPerformance (opsional, muncul kalau kondisi
   relevan terpenuhi).
   ══════════════════════════════════════════════════════════════════ */
function generateExecutiveInsights({ monthlySummary, businessMetrics, outletPerformance }) {
  const insights = [];
  const cur  = monthlySummary[monthlySummary.length - 1];
  const prev = monthlySummary.length >= 2 ? monthlySummary[monthlySummary.length - 2] : null;

  if (cur && prev && prev.totalTrx > 0) {
    const projGrowth = ((cur.projectedEomTrx - prev.totalTrx) / prev.totalTrx) * 100;
    insights.push({
      id: 'proj_trx_growth',
      text: `Transaksi bulan ini diproyeksikan ${projGrowth >= 0 ? 'tumbuh' : 'turun'} ${Math.abs(projGrowth).toFixed(1)}% dibanding bulan lalu.`,
    });
  }

  if (cur && cur.momRevenueGrowth != null && cur.momTrxGrowth != null && cur.momRevenueGrowth < cur.momTrxGrowth) {
    insights.push({ id: 'revenue_lag', text: 'Revenue tumbuh lebih lambat dari trx, indikasi revenue per transaksi menurun.' });
  }

  const churnCount = outletPerformance.filter(o => o.segment === 'churn').length;
  if (churnCount > 0) {
    insights.push({ id: 'churn_count', text: `Ada ${churnCount} outlet aktif bulan lalu yang belum transaksi bulan ini.` });
  }

  if (businessMetrics.dependencyRisk != null) {
    insights.push({
      id: 'dependency_risk',
      text: `Top 10 outlet menyumbang ${(businessMetrics.dependencyRisk * 100).toFixed(1)}% revenue. Cek risiko ketergantungan.`,
    });
  }

  const oneTimerCount = outletPerformance.filter(o => o.segment === 'one_timer').length;
  if (oneTimerCount > 0) {
    insights.push({ id: 'one_timer_count', text: `${oneTimerCount} outlet hanya 1 transaksi bulan ini. Fokus: dorong repeat order.` });
  }

  return insights;
}

/* ── POST /api/warroom/ekspedisi/sync — token auth, no JWT ──
   Body: { tanggal: 'YYYY-MM-DD', months: [{ bulan: 'YYYY-MM', rows: [{id_outlet, trx, revenue}] }, ...] }
   Skema (ekspedisi_monthly, long format) — bulan baru otomatis masuk
   tanpa perlu ubah schema/backend, tinggal kirim block bulan baru. */
async function syncHandler(req, res) {
  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (token !== SECRET_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

    const { tanggal, months } = req.body;
    if (!tanggal || !Array.isArray(months)) {
      return res.status(400).json({ error: 'tanggal and months[] required' });
    }

    let count = 0;
    for (const block of months) {
      const bulan = String(block?.bulan || '').trim();
      if (!/^\d{4}-\d{2}$/.test(bulan)) continue;
      const rows = Array.isArray(block.rows) ? block.rows : [];

      for (const r of rows) {
        const id = String(r.id_outlet || '').trim();
        if (!id) continue;
        const trx = parseTrx(r.trx);
        const revenue = parseRevenue(r.revenue);

        await pool.query(`
          INSERT INTO ekspedisi_monthly (tanggal, id_outlet, bulan, trx, revenue, synced_at)
          VALUES ($1,$2,$3,$4,$5,NOW())
          ON CONFLICT (tanggal, id_outlet, bulan) DO UPDATE SET
            trx=EXCLUDED.trx, revenue=EXCLUDED.revenue, synced_at=NOW()
        `, [tanggal, id, bulan, trx, revenue]);
        count++;
      }
    }

    res.json({ success: true, rows: count, tanggal });
  } catch (e) {
    console.error('ekspedisi sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

/* ── GET /api/warroom/ekspedisi/analytics — requires JWT ──
   Response berisi DUA lapis:
   1) Shape lama (tanggal/dayCutoff/currentMonthLabel/months/outlets/
      history/summary) — dipertahankan APA ADANYA karena sudah dipakai
      WarRoomEkspedisi.jsx yang live di production. JANGAN diubah.
   2) Shape baru — business logic layer (meta/monthlyFacts/monthlySummary/
      outletPerformance/executiveInsights/charts/queues/businessMetrics)
      untuk dashboard War Room selanjutnya. Belum dikonsumsi UI manapun.
   Semua bulan yang tersedia untuk `tanggal` diambil dinamis dari
   ekspedisi_monthly (tidak dibatasi 3 bulan). */
async function analyticsHandler(req, res) {
  try {
    let { tanggal, currentMonth, previousMonth } = req.query;
    if (!tanggal) {
      const r = await pool.query("SELECT TO_CHAR(MAX(tanggal), 'YYYY-MM-DD') AS t FROM ekspedisi_monthly");
      tanggal = r.rows[0]?.t;
    }
    const emptyShape = {
      tanggal: tanggal || null, dayCutoff: null, currentMonthLabel: null,
      months: [], outlets: [], history: [], summary: {},
      meta: {}, monthlyFacts: [], monthlySummary: [], outletPerformance: [],
      executiveInsights: [], charts: {}, queues: {}, businessMetrics: {},
    };
    if (!tanggal) return res.json(emptyShape);

    const bulanRes = await pool.query(
      'SELECT DISTINCT bulan FROM ekspedisi_monthly WHERE tanggal=$1 ORDER BY bulan ASC',
      [tanggal]
    );
    const bulanList = bulanRes.rows.map(r => r.bulan);
    if (!bulanList.length) return res.json({ ...emptyShape, tanggal });

    // bulan "sungguhan" yang sedang berjalan (dipakai untuk proyeksi EOM di
    // monthlySummary) SELALU bulan terakhir kronologis — terpisah dari
    // pasangan current/previous yang bisa dipilih user lewat query param
    // (?currentMonth=&previousMonth=) untuk keperluan perbandingan bebas.
    const latestBulan = bulanList[bulanList.length - 1];
    const dayCutoff = parseInt(String(tanggal).split('-')[2], 10) || null;

    const bCurrent = (currentMonth && bulanList.includes(currentMonth)) ? currentMonth : latestBulan;
    let bPrev;
    if (previousMonth && bulanList.includes(previousMonth)) {
      bPrev = previousMonth;
    } else {
      const idx = bulanList.indexOf(bCurrent);
      bPrev = idx > 0 ? bulanList[idx - 1] : null;
    }

    const histRes = await pool.query(
      'SELECT id_outlet, bulan, trx, revenue FROM ekspedisi_monthly WHERE tanggal=$1 ORDER BY id_outlet, bulan',
      [tanggal]
    );

    const monthOrderMap = {};
    bulanList.forEach((b, i) => { monthOrderMap[b] = i + 1; });

    // ── shape lama: history[] ──
    const history = histRes.rows.map(r => ({
      idOutlet: r.id_outlet,
      bulan: r.bulan,
      monthLabel: monthLabel(r.bulan),
      monthOrder: monthOrderMap[r.bulan],
      trx: Number(r.trx),
      revenue: Number(r.revenue),
    }));

    // ── shape baru: monthlyFacts[] (sama sumber data, field lebih lengkap) ──
    const monthlyFacts = histRes.rows.map(r => {
      const trx = Number(r.trx);
      const revenue = Number(r.revenue);
      return {
        idOutlet: r.id_outlet,
        monthLabel: monthLabel(r.bulan),
        monthIndex: parseInt(r.bulan.split('-')[1], 10),
        monthOrder: monthOrderMap[r.bulan],
        trx, revenue,
        avgRevenuePerTrx: trx > 0 ? revenue / trx : 0,
        dayCutoff: r.bulan === bCurrent ? dayCutoff : null,
        sourceRow: null, // fakta ini dari DB (ekspedisi_monthly) — sourceRow hanya relevan saat parsing langsung dari raw grid via normalizeEkspedisiRows()
      };
    });
    const monthlyFactsByOutlet = {};
    monthlyFacts.forEach(f => {
      if (!monthlyFactsByOutlet[f.idOutlet]) monthlyFactsByOutlet[f.idOutlet] = [];
      monthlyFactsByOutlet[f.idOutlet].push(f);
    });

    // ── agregat per bulan (dipakai shape lama `months[]` & baru `monthlySummary[]`) ──
    const monthAgg = {};
    for (const row of histRes.rows) {
      const b = row.bulan;
      if (!monthAgg[b]) monthAgg[b] = { activeOutlets: 0, totalTrx: 0, totalRevenue: 0 };
      if (Number(row.trx) > 0) monthAgg[b].activeOutlets++;
      monthAgg[b].totalTrx += Number(row.trx);
      monthAgg[b].totalRevenue += Number(row.revenue);
    }

    const months = bulanList.map((b, i) => {
      const agg     = monthAgg[b] || { activeOutlets: 0, totalTrx: 0, totalRevenue: 0 };
      const prevB   = i > 0 ? bulanList[i - 1] : null;
      const prevAgg = prevB ? monthAgg[prevB] : null;
      return {
        bulan: b,
        monthLabel: monthLabel(b),
        monthIndex: parseInt(b.split('-')[1], 10),
        monthOrder: i + 1,
        isCurrent: b === bCurrent,
        totalOutlet: agg.activeOutlets,
        totalTrx: agg.totalTrx,
        totalRevenue: agg.totalRevenue,
        momTrxPct: prevAgg && prevAgg.totalTrx > 0 ? ((agg.totalTrx - prevAgg.totalTrx) / prevAgg.totalTrx * 100) : null,
        momRevenuePct: prevAgg && prevAgg.totalRevenue > 0 ? ((agg.totalRevenue - prevAgg.totalRevenue) / prevAgg.totalRevenue * 100) : null,
      };
    });

    const monthlySummary = aggregateMonthlySummary(bulanList, monthAgg, dayCutoff);

    // ── pivot current vs prev (2-tier) — dipakai shape lama `outlets[]` & baru `outletPerformance[]` ──
    const pivotMap = {};
    for (const row of histRes.rows) {
      const id = row.id_outlet;
      if (!pivotMap[id]) pivotMap[id] = { idOutlet: id, trxCurrent: 0, revenueCurrent: 0, trxPrev: 0, revenuePrev: 0 };
      if (row.bulan === bCurrent) {
        pivotMap[id].trxCurrent = Number(row.trx);
        pivotMap[id].revenueCurrent = Number(row.revenue);
      } else if (bPrev && row.bulan === bPrev) {
        pivotMap[id].trxPrev = Number(row.trx);
        pivotMap[id].revenuePrev = Number(row.revenue);
      }
    }
    const outlets = Object.values(pivotMap).map(o => {
      const devTrx = o.trxCurrent - o.trxPrev;
      const devRevenue = o.revenueCurrent - o.revenuePrev;
      const pctTrxGrowth = o.trxPrev > 0 ? (devTrx / o.trxPrev * 100) : null;
      const pctRevenueGrowth = o.revenuePrev > 0 ? (devRevenue / o.revenuePrev * 100) : null;

      let status;
      if (o.trxPrev === 0 && o.trxCurrent > 0)      status = 'new';
      else if (o.trxCurrent === 0 && o.trxPrev > 0) status = 'churned';
      else if (devTrx > 0)                          status = 'growing';
      else if (devTrx < 0)                          status = 'declining';
      else                                           status = 'stable';

      return { ...o, devTrx, devRevenue, pctTrxGrowth, pctRevenueGrowth, status };
    });

    const totalOutlet       = outlets.length;
    const totalOutletActive = outlets.filter(o => o.trxCurrent > 0).length;
    const totalTrxCurrent   = outlets.reduce((s, o) => s + o.trxCurrent, 0);
    const totalRevenueCurrent = outlets.reduce((s, o) => s + o.revenueCurrent, 0);
    const totalTrxPrev      = outlets.reduce((s, o) => s + o.trxPrev, 0);
    const totalRevenuePrev  = outlets.reduce((s, o) => s + o.revenuePrev, 0);
    const totalNew          = outlets.filter(o => o.status === 'new').length;
    const totalChurned      = outlets.filter(o => o.status === 'churned').length;

    const summary = {
      totalOutlet, totalOutletActive,
      totalTrxCurrent, totalRevenueCurrent, totalTrxPrev, totalRevenuePrev,
      pctTrxGrowth: totalTrxPrev > 0 ? ((totalTrxCurrent - totalTrxPrev) / totalTrxPrev * 100) : 0,
      pctRevenueGrowth: totalRevenuePrev > 0 ? ((totalRevenueCurrent - totalRevenuePrev) / totalRevenuePrev * 100) : 0,
      avgRevPerTrx: totalTrxCurrent > 0 ? (totalRevenueCurrent / totalTrxCurrent) : 0,
      totalNew, totalChurned,
    };

    // ── klasifikasi (percentile/median) untuk segmentasi outlet ──
    const trxMaxArr = outlets.map(o => Math.max(o.trxCurrent, o.trxPrev)).sort((a, b) => a - b);
    const revMaxArr = outlets.map(o => Math.max(o.revenueCurrent, o.revenuePrev)).sort((a, b) => a - b);
    const trxP90 = percentile(trxMaxArr, 90);
    const revP90 = percentile(revMaxArr, 90);
    const activeCurrentTrxArr = outlets.filter(o => o.trxCurrent > 0).map(o => o.trxCurrent);
    const medianTrxCurrent = median(activeCurrentTrxArr);
    const avgRevPerTrxArr = outlets.filter(o => o.trxCurrent > 0).map(o => o.revenueCurrent / o.trxCurrent);
    const medianAvgRevPerTrx = median(avgRevPerTrxArr);

    const outletPerformance = buildOutletPerformance(outlets, monthlyFactsByOutlet, {
      trxP90, revP90, medianAvgRevPerTrx, medianTrxCurrent, bCurrent, bPrev,
    });

    // ── business metrics ──
    const activeOutletPreviousMonth = outlets.filter(o => o.trxPrev > 0).length;
    const activeOutletCurrentMonth  = totalOutletActive;
    const retainedOutlet = outlets.filter(o => o.trxPrev > 0 && o.trxCurrent > 0).length;
    const churnOutletCount = outletPerformance.filter(o => o.segment === 'churn').length;
    const newOutletCount   = outletPerformance.filter(o => o.segment === 'new_active').length;
    const top10Revenue = [...outlets].sort((a, b) => b.revenueCurrent - a.revenueCurrent).slice(0, 10)
      .reduce((s, o) => s + o.revenueCurrent, 0);

    const businessMetrics = {
      retentionRate: activeOutletPreviousMonth > 0 ? retainedOutlet / activeOutletPreviousMonth : null,
      churnRate: activeOutletPreviousMonth > 0 ? churnOutletCount / activeOutletPreviousMonth : null,
      newOutletRate: activeOutletCurrentMonth > 0 ? newOutletCount / activeOutletCurrentMonth : null,
      dependencyRisk: totalRevenueCurrent > 0 ? top10Revenue / totalRevenueCurrent : null,
      productivity: activeOutletCurrentMonth > 0 ? totalTrxCurrent / activeOutletCurrentMonth : 0,
      avgRevenuePerTrx: totalTrxCurrent > 0 ? totalRevenueCurrent / totalTrxCurrent : 0,
    };

    const executiveInsights = generateExecutiveInsights({ monthlySummary, businessMetrics, outletPerformance });

    const charts = {
      trend: monthlySummary.map(m => ({ monthLabel: m.monthLabel, totalTrx: m.totalTrx, totalRevenue: m.totalRevenue })),
      segmentDistribution: Object.keys(SEGMENT_ACTION).map(seg => ({ segment: seg, count: outletPerformance.filter(o => o.segment === seg).length })),
      priorityDistribution: ['P0', 'P1', 'P2', 'P3'].map(p => ({ priority: p, count: outletPerformance.filter(o => o.priority === p).length })),
    };

    const bySegment = seg => outletPerformance.filter(o => o.segment === seg);
    const byPriority = p => outletPerformance.filter(o => o.priority === p);
    const queues = {
      p0: byPriority('P0').sort((a, b) => (b.previousRevenue || 0) - (a.previousRevenue || 0)).slice(0, 100),
      p1: byPriority('P1').sort((a, b) => (a.revenueDelta || 0) - (b.revenueDelta || 0)).slice(0, 100),
      p2: byPriority('P2').sort((a, b) => (b.currentRevenue || 0) - (a.currentRevenue || 0)).slice(0, 100),
      p3: byPriority('P3').sort((a, b) => (b.currentRevenue || 0) - (a.currentRevenue || 0)).slice(0, 100),
      churn: bySegment('churn').sort((a, b) => (b.previousRevenue || 0) - (a.previousRevenue || 0)).slice(0, 100),
      declining: bySegment('declining').sort((a, b) => (a.revenueDelta || 0) - (b.revenueDelta || 0)).slice(0, 100),
      oneTimer: bySegment('one_timer').sort((a, b) => (b.currentRevenue || 0) - (a.currentRevenue || 0)).slice(0, 100),
      whale: bySegment('whale').sort((a, b) => (b.currentRevenue || 0) - (a.currentRevenue || 0)).slice(0, 100),
      lowYield: bySegment('low_yield').sort((a, b) => (b.currentTrx || 0) - (a.currentTrx || 0)).slice(0, 100),
      newActive: bySegment('new_active').sort((a, b) => (b.currentRevenue || 0) - (a.currentRevenue || 0)).slice(0, 100),
    };

    const lastSyncRes = await pool.query('SELECT MAX(synced_at) AS t FROM ekspedisi_monthly WHERE tanggal=$1', [tanggal]);

    // ── revenue/trx hari terakhir — ekspedisi_monthly menyimpan kumulatif
    //    month-to-date per tanggal sync, jadi "hari terakhir" = delta antara
    //    sync tanggal ini vs sync sebelumnya (bukan nilai kumulatif itu sendiri).
    //    Selalu terikat ke latestBulan (bulan yang sungguhan sedang berjalan),
    //    sama seperti Projected EOM & Daily Revenue di atas.
    const prevSyncRes = await pool.query(
      "SELECT TO_CHAR(MAX(tanggal), 'YYYY-MM-DD') AS t FROM ekspedisi_monthly WHERE bulan=$1 AND tanggal < $2",
      [latestBulan, tanggal]
    );
    const prevSyncTanggal = prevSyncRes.rows[0]?.t || null;
    const latestAgg = monthAgg[latestBulan] || { totalTrx: 0, totalRevenue: 0 };
    let lastDayRevenue = latestAgg.totalRevenue;
    let lastDayTrx = latestAgg.totalTrx;
    if (prevSyncTanggal) {
      const prevSyncAgg = await pool.query(
        'SELECT COALESCE(SUM(revenue),0) AS revenue, COALESCE(SUM(trx),0) AS trx FROM ekspedisi_monthly WHERE tanggal=$1 AND bulan=$2',
        [prevSyncTanggal, latestBulan]
      );
      lastDayRevenue = latestAgg.totalRevenue - Number(prevSyncAgg.rows[0]?.revenue || 0);
      lastDayTrx = latestAgg.totalTrx - Number(prevSyncAgg.rows[0]?.trx || 0);
    }

    const meta = {
      source: 'ekspedisi_monthly',
      dayCutoff,
      monthsDetected: bulanList,
      currentMonth: bCurrent,
      previousMonth: bPrev,
      latestMonth: latestBulan, // bulan yang sungguhan sedang berjalan (proyeksi EOM selalu terikat ke ini, terlepas dari currentMonth pilihan user)
      lastUpdated: lastSyncRes.rows[0]?.t || null,
      lastDayDate: tanggal,
      lastDayPrevDate: prevSyncTanggal, // null kalau tanggal ini sync pertama utk latestBulan (belum ada pembanding)
      lastDayRevenue,
      lastDayTrx,
    };

    res.json({
      // ── shape lama — JANGAN diubah, masih dipakai WarRoomEkspedisi.jsx ──
      tanggal,
      dayCutoff,
      currentMonthLabel: monthLabel(bCurrent),
      months,
      outlets,
      history,
      summary,

      // ── shape baru — business logic layer ──
      meta,
      monthlyFacts,
      monthlySummary,
      outletPerformance,
      executiveInsights,
      charts,
      queues,
      businessMetrics,
    });
  } catch (e) {
    console.error('ekspedisi analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

/* ══════════════════════════════════════════════════════════════════
   Execution Queue — persist Mark Contacted / Assign PIC / Follow-up
   Date (current-state, 1 baris per outlet, upsert) & Notes (log
   append-only, banyak baris per outlet).
   ══════════════════════════════════════════════════════════════════ */
function mapStatusRow(r) {
  return {
    idOutlet: r.id_outlet,
    isContacted: r.is_contacted,
    contactedAt: r.contacted_at,
    contactedBy: r.contacted_by,
    pic: r.pic,
    followupDate: r.followup_date,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}
function mapNoteRow(r) {
  return { id: r.id, idOutlet: r.id_outlet, note: r.note, createdBy: r.created_by, createdAt: r.created_at };
}

/* ── GET /api/warroom/ekspedisi/outlet-status — requires JWT ── */
async function outletStatusHandler(req, res) {
  try {
    const r = await pool.query('SELECT * FROM ekspedisi_outlet_status ORDER BY updated_at DESC');
    res.json(r.rows.map(mapStatusRow));
  } catch (e) {
    console.error('ekspedisi outlet-status GET error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

/* ── POST /api/warroom/ekspedisi/outlet-status — requires JWT ──
   Partial upsert: { idOutlet, isContacted?, pic?, followupDate? } — hanya
   field yang dikirim yang berubah (COALESCE ke nilai lama). Satu endpoint
   ini menangani Mark Contacted, Assign PIC, dan Set Follow-up Date. */
async function updateOutletStatusHandler(req, res) {
  try {
    const { idOutlet, isContacted, pic, followupDate } = req.body;
    const id = String(idOutlet || '').trim();
    if (!id) return res.status(400).json({ error: 'idOutlet required' });

    const username = req.user?.username || null;
    const contactedAtSet = isContacted === true;
    const contactedAtClear = isContacted === false;

    const r = await pool.query(`
      INSERT INTO ekspedisi_outlet_status (id_outlet, is_contacted, contacted_at, contacted_by, pic, followup_date, updated_at, updated_by)
      VALUES ($1, COALESCE($2, FALSE), CASE WHEN $2 = TRUE THEN NOW() ELSE NULL END, CASE WHEN $2 = TRUE THEN $5 ELSE NULL END, $3, $4, NOW(), $5)
      ON CONFLICT (id_outlet) DO UPDATE SET
        is_contacted  = COALESCE($2, ekspedisi_outlet_status.is_contacted),
        contacted_at  = CASE
                           WHEN $2 = TRUE  THEN NOW()
                           WHEN $2 = FALSE THEN NULL
                           ELSE ekspedisi_outlet_status.contacted_at
                         END,
        contacted_by  = CASE
                           WHEN $2 = TRUE  THEN $5
                           WHEN $2 = FALSE THEN NULL
                           ELSE ekspedisi_outlet_status.contacted_by
                         END,
        pic           = COALESCE($3, ekspedisi_outlet_status.pic),
        followup_date = COALESCE($4, ekspedisi_outlet_status.followup_date),
        updated_at    = NOW(),
        updated_by    = $5
      RETURNING *
    `, [id, isContacted === undefined ? null : isContacted, pic || null, followupDate || null, username]);

    res.json(mapStatusRow(r.rows[0]));
  } catch (e) {
    console.error('ekspedisi outlet-status POST error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

/* ── GET /api/warroom/ekspedisi/notes?idOutlet= — requires JWT ── */
async function notesHandler(req, res) {
  try {
    const idOutlet = String(req.query.idOutlet || '').trim();
    if (!idOutlet) return res.status(400).json({ error: 'idOutlet required' });
    const r = await pool.query('SELECT * FROM ekspedisi_outlet_notes WHERE id_outlet=$1 ORDER BY created_at DESC', [idOutlet]);
    res.json(r.rows.map(mapNoteRow));
  } catch (e) {
    console.error('ekspedisi notes GET error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

/* ── POST /api/warroom/ekspedisi/notes — requires JWT ── */
async function addNoteHandler(req, res) {
  try {
    const idOutlet = String(req.body.idOutlet || '').trim();
    const note = String(req.body.note || '').trim();
    if (!idOutlet || !note) return res.status(400).json({ error: 'idOutlet and note required' });

    const username = req.user?.username || null;
    const r = await pool.query(
      'INSERT INTO ekspedisi_outlet_notes (id_outlet, note, created_by) VALUES ($1,$2,$3) RETURNING *',
      [idOutlet, note, username]
    );
    res.json(mapNoteRow(r.rows[0]));
  } catch (e) {
    console.error('ekspedisi notes POST error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  syncHandler,
  analyticsHandler,
  outletStatusHandler,
  updateOutletStatusHandler,
  notesHandler,
  addNoteHandler,
  // exported untuk testability (pola sama seperti warroom-qris-control-tower.js)
  parseTrx,
  parseRevenue,
  detectMonthGroups,
  normalizeEkspedisiRows,
  aggregateMonthlySummary,
  assignSegment,
  assignPriority,
  buildOutletPerformance,
  generateExecutiveInsights,
};
