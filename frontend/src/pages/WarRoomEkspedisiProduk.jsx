import { useState, useEffect, useMemo, useCallback } from 'react';
import Layout from '../components/Layout';
import { getEkspedisiProdukMonths, getEkspedisiProdukAnalytics, getEkspedisiProdukOutlets } from '../services/api';

const COLOR = '#0EA5E9';
const OUTLET_LIMIT = 50;

/* ─── Format helpers ─── */
function fmtN(v) {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) return '-';
  return n.toLocaleString('id-ID');
}
function fmtRp(v) {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}Rp ${(abs / 1e9).toFixed(1)}M`;
  if (abs >= 1e6) return `${sign}Rp ${(abs / 1e6).toFixed(1)}jt`;
  if (abs >= 1e3) return `${sign}Rp ${(abs / 1e3).toFixed(0)}rb`;
  return `${sign}Rp ${Math.round(abs)}`;
}
function fmtPct(v, digits = 1) {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) return '-';
  const pct = Math.abs(n) <= 1.5 ? n * 100 : n;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}
function fmtDateTime(v) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtDate(v) {
  if (!v) return '-';
  const iso = String(v).slice(0, 10);
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return '-';
  return `${d}/${m}/${y}`;
}

/* ─── Metadata presentasi (frontend-only) ─── */
const STATUS_META = {
  naik:          { label: 'Naik',           color: '#059669', bg: '#DCFCE7' },
  turun:         { label: 'Turun',          color: '#DC2626', bg: '#FEE2E2' },
  stabil:        { label: 'Stabil',         color: '#3B82F6', bg: '#DBEAFE' },
  zero_activity: { label: 'Tanpa Aktivitas', color: '#B45309', bg: '#FEF3C7' },
  no_data:       { label: 'Belum Ada Data', color: '#6B7280', bg: '#F3F4F6' },
};
function statusMeta(s) { return STATUS_META[s] || STATUS_META.no_data; }

const PRIORITY_META = {
  P0: { label: 'Selamatkan Produk Turun', color: '#DC2626' },
  P1: { label: 'Optimasi Produk Aktif',   color: '#F59E0B' },
  P2: { label: 'Jaga Momentum',           color: '#3B82F6' },
  P3: { label: 'Scale Produk Naik',       color: '#059669' },
  P4: { label: 'Data Quality',            color: '#6B7280' },
};
function priorityMeta(p) { return PRIORITY_META[p] || { label: p || '-', color: '#9CA3AF' }; }

const SEVERITY_META = {
  high:   { label: 'Tinggi', color: '#DC2626', bg: '#FEE2E2' },
  medium: { label: 'Sedang', color: '#B45309', bg: '#FEF3C7' },
  low:    { label: 'Rendah', color: '#1D4ED8', bg: '#DBEAFE' },
};
function severityMeta(s) { return SEVERITY_META[s] || SEVERITY_META.low; }

/* ─── UI atoms ─── */
function KPICard({ label, value, sub, alert }) {
  return (
    <div className={'eprod-kpi-card' + (alert ? ' eprod-kpi-card--alert' : '')}>
      <div className="eprod-kpi-label">{label}</div>
      <div className="eprod-kpi-value">{value}</div>
      {sub && <div className="eprod-kpi-sub">{sub}</div>}
    </div>
  );
}
function StatusBadge({ status }) {
  const m = statusMeta(status);
  return <span className="eprod-status-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}
function GrowthStat({ label, pct }) {
  const n = Number(pct);
  const known = pct !== null && pct !== undefined && !Number.isNaN(n);
  const color = !known ? 'var(--text-4)' : (n >= 0 ? '#059669' : '#DC2626');
  return (
    <div className="eprod-growth-stat">
      <div className="eprod-growth-label">{label}</div>
      <div className="eprod-growth-value" style={{ color }}>{known ? fmtPct(n) : 'Tidak tersedia'}</div>
    </div>
  );
}

function TopList({ title, icon, rows, valueKey, valueFmt, onSelect }) {
  return (
    <div className="eprod-toplist">
      <div className="eprod-toplist-title"><i className={icon} style={{ color: COLOR }} /> {title}</div>
      {rows.length === 0 && <div className="eprod-empty-sub">Tidak ada data.</div>}
      {rows.length > 0 && (
        <ol className="eprod-toplist-items">
          {rows.map((r, i) => (
            <li key={i} onClick={() => onSelect?.(r.id_produk)} className="eprod-toplist-item">
              <span className="eprod-toplist-name">{r.produk || r.id_produk}</span>
              <span className="eprod-toplist-value">{valueFmt(r[valueKey])}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ─── Outlet Drilldown ─── */
function OutletDrilldown({ bulan, idProduk, produkNama, onClose }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true); setError(null);
    getEkspedisiProdukOutlets({ bulan, id_produk: idProduk, page, limit: OUTLET_LIMIT, search: search || undefined })
      .then(res => { setRows(res.rows || []); setMeta(res.meta || null); })
      .catch(e => setError(e.message || 'Gagal memuat detail outlet'))
      .finally(() => setLoading(false));
  }, [bulan, idProduk, page, search]);

  const totalPages = meta ? Math.max(1, Math.ceil(meta.total / meta.limit)) : 1;

  return (
    <div className="eprod-panel" id="eprod-drilldown">
      <div className="eprod-panel-title-row">
        <div className="eprod-panel-title"><i className="ti ti-building-store" style={{ color: COLOR }} /> Detail Outlet — {produkNama || idProduk}</div>
        <button className="eprod-close-btn" onClick={onClose}><i className="ti ti-x" /> Tutup</button>
      </div>
      <input
        className="eprod-search-input"
        placeholder="Cari ID Outlet..."
        value={search}
        onChange={e => { setSearch(e.target.value); setPage(1); }}
      />
      {loading && <div className="eprod-empty-sub">Memuat...</div>}
      {!loading && error && <div className="eprod-empty-sub">Gagal memuat: {error}</div>}
      {!loading && !error && rows.length === 0 && <div className="eprod-empty-sub">Belum ada detail outlet untuk produk ini.</div>}
      {!loading && !error && rows.length > 0 && (<>
        <div className="eprod-table-wrap">
          <table className="eprod-table">
            <thead>
              <tr><th>Tanggal</th><th>ID Outlet</th><th>Jml Bill</th><th>Margin FP</th><th>Avg Margin/Bill</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{fmtDate(r.tanggal)}</td>
                  <td>{r.id_outlet}</td>
                  <td>{fmtN(r.jml_bill)}</td>
                  <td>{fmtRp(r.margin_fp)}</td>
                  <td>{fmtRp(r.avg_margin_per_bill)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="eprod-pagination">
          <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Sebelumnya</button>
          <span>Halaman {page} dari {totalPages} ({fmtN(meta?.total)} baris)</span>
          <button disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Berikutnya</button>
        </div>
      </>)}
    </div>
  );
}

/* ─── Main ─── */
export default function WarRoomEkspedisiProduk() {
  const [months, setMonths] = useState([]);
  const [bulan, setBulan] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [monthsLoaded, setMonthsLoaded] = useState(false);
  const [selectedProduk, setSelectedProduk] = useState(null);

  useEffect(() => {
    getEkspedisiProdukMonths()
      .then(res => {
        const list = Array.isArray(res) ? res : [];
        setMonths(list);
        setMonthsLoaded(true);
        if (list.length) setBulan(list[list.length - 1].bulan);
        else setLoading(false);
      })
      .catch(e => { setError(e.message || 'Gagal memuat daftar bulan'); setMonthsLoaded(true); setLoading(false); });
  }, []);

  useEffect(() => {
    if (!bulan) return;
    setLoading(true); setError(null); setSelectedProduk(null);
    getEkspedisiProdukAnalytics(bulan)
      .then(setAnalytics)
      .catch(e => setError(e.message || 'Gagal memuat analytics'))
      .finally(() => setLoading(false));
  }, [bulan]);

  const isEmpty = monthsLoaded && !error && (months.length === 0 || analytics?.empty === true);

  const meta = analytics?.meta;
  const summary = analytics?.summary;
  const products = Array.isArray(analytics?.products) ? analytics.products : [];
  const topProducts = analytics?.top_products || {};
  const outletSummary = analytics?.outlet_summary || {};
  const insights = Array.isArray(analytics?.insights) ? analytics.insights.slice(0, 5) : [];
  const actionSummary = Array.isArray(analytics?.action_summary) ? analytics.action_summary : [];
  const dataQuality = Array.isArray(analytics?.data_quality) ? analytics.data_quality : [];

  const selectedProdukNama = useMemo(
    () => products.find(p => p.id_produk === selectedProduk)?.produk,
    [products, selectedProduk]
  );

  const handleSelectProduk = useCallback((idProduk) => {
    setSelectedProduk(idProduk);
    setTimeout(() => document.getElementById('eprod-drilldown')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }, []);

  const formulaErrorCheck = dataQuality.find(d => d.key === 'formula_error_count');
  const hasFormulaError = formulaErrorCheck && Number(formulaErrorCheck.count) > 0;

  return (
    <Layout>
      <div className="eprod-page">

        {/* Header */}
        <div className="eprod-header">
          <div className="eprod-header-left">
            <i className="ti ti-package" style={{ color: COLOR, fontSize: 24 }} />
            <div>
              <div className="eprod-header-title">Produk Ekspedisi</div>
              <div className="eprod-header-sub">Monitoring performa produk ekspedisi berdasarkan MAT, jumlah bill, margin, pertumbuhan bulanan, dan kontribusi outlet.</div>
            </div>
          </div>
          <div className="eprod-header-right">
            {months.length > 0 && (
              <select className="eprod-select" value={bulan || ''} onChange={e => setBulan(e.target.value)}>
                {months.map(m => <option key={m.bulan} value={m.bulan}>{m.label || m.bulan}</option>)}
              </select>
            )}
            {meta?.day_number != null && (
              <span className="eprod-badge">Day {meta.day_number}</span>
            )}
            {meta?.last_sync && (
              <span className="eprod-badge eprod-badge-sync">
                <i className="ti ti-refresh" /> Sync terakhir: {fmtDateTime(meta.last_sync)}
              </span>
            )}
          </div>
        </div>

        {/* States */}
        {loading && <div className="eprod-loading"><i className="ti ti-loader-2 eprod-spin" /> Memuat data...</div>}
        {!loading && error && <div className="eprod-error"><i className="ti ti-alert-circle" /> {error}</div>}
        {!loading && !error && months.length === 0 && (
          <div className="eprod-empty">
            <i className="ti ti-package" />
            <div>Data Produk Ekspedisi belum tersedia. Jalankan sync Google Sheet terlebih dahulu.</div>
          </div>
        )}
        {!loading && !error && months.length > 0 && analytics?.empty === true && (
          <div className="eprod-empty">
            <i className="ti ti-calendar-off" />
            <div>Bulan belum tersedia.</div>
          </div>
        )}

        {!loading && !error && !isEmpty && analytics && (<>

          {hasFormulaError && (
            <div className="eprod-warning-banner">
              <i className="ti ti-alert-triangle" />
              <div>Google Sheet masih memiliki formula error. Angka terkait akan dibaca sebagai null/0 agar dashboard tidak error.</div>
            </div>
          )}

          {/* KPI Cards */}
          <div className="eprod-kpi-grid">
            <KPICard label="Total Produk" value={fmtN(summary?.total_produk)} />
            <KPICard label="Total MAT" value={fmtN(summary?.total_mat)} />
            <KPICard label="Total Bill" value={fmtN(summary?.total_jml_bill)} />
            <KPICard label="Total Margin" value={fmtRp(summary?.total_margin_fp)} />
            <KPICard label="Avg Margin / Bill" value={fmtRp(summary?.avg_margin_per_bill)} />
            <KPICard label="Avg Bill / MAT" value={fmtN(summary?.avg_bill_per_mat)} />
            <KPICard label="Produk Naik" value={fmtN(summary?.produk_naik_vs_previous_count)} />
            <KPICard label="Produk Turun" value={fmtN(summary?.produk_turun_vs_previous_count)} alert={(summary?.produk_turun_vs_previous_count || 0) > 0} />
            <KPICard label="Produk Margin 0" value={fmtN(summary?.produk_margin_0_count)} alert={(summary?.produk_margin_0_count || 0) > 0} />
          </div>

          {/* Growth Summary */}
          <div className="eprod-panel">
            <div className="eprod-panel-title"><i className="ti ti-trending-up" style={{ color: COLOR }} /> Growth Summary</div>
            <div className="eprod-growth-row">
              <GrowthStat label={`Vs ${meta?.previous_bulan_label || 'Bulan Sebelumnya'}`} pct={summary?.margin_growth_vs_previous_pct} />
              <GrowthStat label="Vs Mei" pct={summary?.margin_growth_vs_may_pct} />
              <GrowthStat label="Vs Juni" pct={summary?.margin_growth_vs_june_pct} />
            </div>
          </div>

          {/* Top Products */}
          <div className="eprod-panel">
            <div className="eprod-panel-title"><i className="ti ti-trophy" style={{ color: COLOR }} /> Top Products</div>
            <div className="eprod-toplist-grid">
              <TopList title="Top by Margin" icon="ti ti-coin" rows={topProducts.top_by_margin || []} valueKey="margin_fp" valueFmt={fmtRp} onSelect={handleSelectProduk} />
              <TopList title="Top by Bill" icon="ti ti-receipt" rows={topProducts.top_by_bill || []} valueKey="jml_bill" valueFmt={fmtN} onSelect={handleSelectProduk} />
              <TopList title="Top by MAT" icon="ti ti-users" rows={topProducts.top_by_mat || []} valueKey="mat" valueFmt={fmtN} onSelect={handleSelectProduk} />
              <TopList title="Top Growth" icon="ti ti-arrow-up-right" rows={topProducts.top_growth || []} valueKey="margin_growth_pct" valueFmt={fmtPct} onSelect={handleSelectProduk} />
              <TopList title="Top Decline" icon="ti ti-arrow-down-right" rows={topProducts.top_decline || []} valueKey="margin_growth_pct" valueFmt={fmtPct} onSelect={handleSelectProduk} />
            </div>
          </div>

          {/* Product Performance Table */}
          <div className="eprod-panel">
            <div className="eprod-panel-title"><i className="ti ti-list-details" style={{ color: COLOR }} /> Product Performance</div>
            {products.length === 0 && <div className="eprod-empty-sub">Belum ada data produk.</div>}
            {products.length > 0 && (
              <div className="eprod-table-wrap">
                <table className="eprod-table">
                  <thead>
                    <tr>
                      <th>ID Produk</th><th>Produk</th><th>MAT</th><th>Jml Bill</th><th>Margin FP</th>
                      <th>Avg Margin/Bill</th><th>Growth Margin</th><th>Vs Mei</th><th>Vs Jun</th>
                      <th>Status</th><th>Prioritas</th><th>Rekomendasi</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p, i) => {
                      const pm = priorityMeta(p.priority);
                      return (
                        <tr key={i}>
                          <td>{p.id_produk}</td>
                          <td>{p.produk || '-'}</td>
                          <td>{fmtN(p.mat)}</td>
                          <td>{fmtN(p.jml_bill)}</td>
                          <td>{fmtRp(p.margin_fp)}</td>
                          <td>{fmtRp(p.avg_margin_per_bill)}</td>
                          <td style={{ color: p.margin_growth_pct == null ? undefined : (p.margin_growth_pct >= 0 ? '#059669' : '#DC2626') }}>
                            {p.margin_growth_pct == null ? '-' : fmtPct(p.margin_growth_pct)}
                          </td>
                          <td>{fmtRp(p.vs_mei)}</td>
                          <td>{fmtRp(p.vs_jun)}</td>
                          <td><StatusBadge status={p.status} /></td>
                          <td><span className="eprod-priority-chip" style={{ background: pm.color }}>{p.priority}</span></td>
                          <td className="eprod-reko-cell">{p.recommendation}</td>
                          <td><button className="eprod-link-btn" onClick={() => handleSelectProduk(p.id_produk)}>Lihat Outlet</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Outlet Summary */}
          <div className="eprod-panel">
            <div className="eprod-panel-title"><i className="ti ti-building-store" style={{ color: COLOR }} /> Outlet Summary</div>
            <div className="eprod-kpi-grid eprod-kpi-grid--4">
              <KPICard label="Active Outlet" value={fmtN(outletSummary.active_outlet_count)} />
              <KPICard label="Outlet Rows" value={fmtN(outletSummary.outlet_rows)} />
              <KPICard label="Total Bill" value={fmtN(outletSummary.outlet_total_bill)} />
              <KPICard label="Total Margin" value={fmtRp(outletSummary.outlet_total_margin)} />
            </div>
            <div className="eprod-toplist-grid eprod-toplist-grid--2">
              <TopList title="Top Outlets by Margin" icon="ti ti-crown" rows={(outletSummary.top_outlets_by_margin || []).map(o => ({ ...o, produk: o.id_outlet, id_produk: o.id_outlet }))} valueKey="margin_fp" valueFmt={fmtRp} />
              <TopList title="Top Outlets by Bill" icon="ti ti-receipt-2" rows={(outletSummary.top_outlets_by_bill || []).map(o => ({ ...o, produk: o.id_outlet, id_produk: o.id_outlet }))} valueKey="jml_bill" valueFmt={fmtN} />
            </div>
          </div>

          {/* Outlet Drilldown */}
          {selectedProduk && (
            <OutletDrilldown bulan={bulan} idProduk={selectedProduk} produkNama={selectedProdukNama} onClose={() => setSelectedProduk(null)} />
          )}

          {/* Insight */}
          <div className="eprod-panel">
            <div className="eprod-panel-title"><i className="ti ti-bulb" style={{ color: COLOR }} /> Insight</div>
            {insights.length === 0 && <div className="eprod-empty-sub">Tidak ada insight khusus untuk bulan ini.</div>}
            <div className="eprod-insight-grid">
              {insights.map((ins, i) => {
                const sm = severityMeta(ins.severity);
                return (
                  <div key={i} className="eprod-insight-card" style={{ '--ins-color': sm.color }}>
                    <div className="eprod-insight-top">
                      <span className="eprod-severity-badge" style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>
                    </div>
                    <div className="eprod-insight-desc">{ins.text}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Action Summary */}
          <div className="eprod-panel">
            <div className="eprod-panel-title"><i className="ti ti-list-check" style={{ color: COLOR }} /> Action Summary</div>
            {actionSummary.length === 0 && <div className="eprod-empty-sub">Tidak ada aksi prioritas untuk bulan ini.</div>}
            <div className="eprod-action-grid">
              {actionSummary.map((a, i) => {
                const pm = priorityMeta(a.priority);
                return (
                  <div key={i} className="eprod-action-card" style={{ '--ac-color': pm.color }}>
                    <div className="eprod-action-top">
                      <span className="eprod-priority-badge" style={{ background: pm.color }}>{a.priority} · {pm.label}</span>
                      <span className="eprod-action-count">{fmtN(a.count)}</span>
                    </div>
                    <div className="eprod-action-title">{a.title}</div>
                    {a.recommendation && <div className="eprod-action-reko">{a.recommendation}</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Data Quality */}
          <div className="eprod-panel">
            <div className="eprod-panel-title"><i className="ti ti-database-cog" style={{ color: COLOR }} /> Data Quality</div>
            {dataQuality.filter(d => Number(d.count) > 0).length === 0 && (
              <div className="eprod-empty-sub">Tidak ada isu kualitas data untuk bulan ini.</div>
            )}
            <div className="eprod-dq-list">
              {dataQuality.filter(d => Number(d.count) > 0).map((d, i) => {
                const sm = severityMeta(d.severity);
                return (
                  <div key={i} className="eprod-dq-item" style={{ '--dq-color': sm.color }}>
                    <div className="eprod-dq-top">
                      <div className="eprod-dq-title">{d.label}</div>
                      <span className="eprod-severity-badge" style={{ background: sm.bg, color: sm.color }}>{sm.label}</span>
                      <div className="eprod-dq-count">{fmtN(d.count)}</div>
                    </div>
                    {d.recommendation && <div className="eprod-dq-note">{d.recommendation}</div>}
                  </div>
                );
              })}
            </div>
          </div>

        </>)}
      </div>
    </Layout>
  );
}
