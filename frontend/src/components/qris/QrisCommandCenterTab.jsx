import { useState, useMemo } from 'react';
import QrisFilterBar from './QrisFilterBar';
import QrisWorkQueueTable from './QrisWorkQueueTable';
import { KPICard, FunnelSection, InsightBanner } from './QrisSharedUI';
import { ACCENT, GREEN, AMBER, RED, BLUE, YELLOW, PURPLE, KPI_TOOLTIP, COMMAND_QUICK_FILTERS } from './qrisConstants';
import { aggregateMetrics, buildFunnelMetrics, buildInsights, getTopUrgent, matchesCommandQuickFilter, fmtNum } from './qrisHelpers';

/**
 * Tab 1 — Command Center: ringkasan kondisi besar penerbitan QRIS.
 * `records` di sini SUDAH melewati filter global (date range + search) dari
 * halaman utama — tab ini cuma menambahkan 1 quick-filter lokal di atasnya.
 */
export default function QrisCommandCenterTab({ records, onSelectRow, onAction }) {
  const [quickFilter, setQuickFilter] = useState('Semua');

  const filtered = useMemo(
    () => quickFilter === 'Semua' ? records : records.filter(r => matchesCommandQuickFilter(r, quickFilter)),
    [records, quickFilter]
  );

  const metrics    = useMemo(() => aggregateMetrics(filtered), [filtered]);
  const funnel     = useMemo(() => buildFunnelMetrics(filtered), [filtered]);
  const insights   = useMemo(() => buildInsights(metrics, filtered), [metrics, filtered]);
  const topUrgent  = useMemo(() => getTopUrgent(filtered, 10), [filtered]);

  return (
    <div>
      <QrisFilterBar
        fields={[{ key: 'quick', type: 'quicktabs', options: COMMAND_QUICK_FILTERS }]}
        values={{ quick: quickFilter }}
        onChange={(_, v) => setQuickFilter(v)}
        resultCount={filtered.length}
      />

      <div className="wr-summary-grid" style={{ marginTop: 12 }}>
        <KPICard label="Total Registrasi"         value={fmtNum(metrics.totalRegistrasi)}    color={ACCENT} />
        <KPICard label="QRIS Terbit"               value={fmtNum(metrics.totalQRISTerbit)}    color={GREEN} tooltip={KPI_TOOLTIP.qrisTerbit} />
        <KPICard label="Belum Lengkap"             value={fmtNum(metrics.totalBelumLengkap)}  color={AMBER} />
        <KPICard label="Perbaikan Data / Rejected" value={fmtNum(metrics.totalRejected)}      color={RED} />
        <KPICard label="Menunggu Verifikasi"       value={fmtNum(metrics.totalMenungguVerifikasi)} color={BLUE} />
        <KPICard label="Pending PTEN"              value={fmtNum(metrics.totalPendingPTEN)}   color={YELLOW} />
        <KPICard label="Over SLA"                  value={fmtNum(metrics.totalOverSLA)}       color={RED} tooltip={KPI_TOOLTIP.overSla}
          sub={metrics.totalOverSLA > 0 ? 'perlu prioritas segera' : 'Tidak ada data yang melewati SLA.'} />
        <KPICard label="Issuance Rate"              value={`${metrics.issuanceRate}%`}         color={PURPLE} sub="QRIS Terbit / Total Registrasi" />
      </div>

      <div style={{ marginTop: 16 }}>
        <FunnelSection funnel={funnel} />
      </div>

      <div style={{ marginTop: 16 }}>
        <InsightBanner insights={insights} />
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="wri-chart-title" style={{ fontSize: 15, marginBottom: 8 }}>
          Top Urgent Today <span style={{ fontWeight: 400, color: 'var(--text-3)', fontSize: 12 }}>— maksimal 10 outlet P0</span>
        </div>
        {topUrgent.length ? (
          <QrisWorkQueueTable records={topUrgent} onSelectRow={onSelectRow} onAction={onAction} emptyMessage="Tidak ada antrean urgent. Semua proses kritikal aman." />
        ) : (
          <div className="empty-state">
            <div className="empty-icon">✅</div>
            <div className="empty-title">Tidak ada antrean urgent</div>
            <div className="empty-sub">Semua proses kritikal aman.</div>
          </div>
        )}
      </div>
    </div>
  );
}
