import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import { getQrisControlTowerAnalytics } from '../services/api';

import { ACCENT, QRIS_TABS } from '../components/qris/qrisConstants';
import { aggregateMetrics, fmtDateTime, countByPriorities } from '../components/qris/qrisHelpers';
import { SkeletonCards } from '../components/qris/QrisSharedUI';
import QrisTabNav from '../components/qris/QrisTabNav';
import QrisFilterBar from '../components/qris/QrisFilterBar';
import QrisOutletDetailDrawer from '../components/qris/QrisOutletDetailDrawer';
import { useQrisToast, QrisToast, createQrisActionHandler } from '../components/qris/QrisActionButtons';

import QrisCommandCenterTab from '../components/qris/QrisCommandCenterTab';
import QrisSmartQueueTab from '../components/qris/QrisSmartQueueTab';
import QrisSlaAgingTab from '../components/qris/QrisSlaAgingTab';
import QrisMerchantFollowUpTab from '../components/qris/QrisMerchantFollowUpTab';
import QrisVerificationPtenTab from '../components/qris/QrisVerificationPtenTab';
import QrisRejectBottleneckTab from '../components/qris/QrisRejectBottleneckTab';
import QrisRawAuditTab from '../components/qris/QrisRawAuditTab';

/**
 * QRIS Issuance Control Tower — refactor multi-tab.
 *
 * Halaman ini SEKARANG jadi orchestrator tipis: fetch data (TIDAK berubah
 * dari sebelumnya), simpan filter global (date range + search) + activeTab,
 * lalu render HANYA tab yang aktif (conditional render — tab lain tidak
 * ikut mount/hitung berat sekaligus). Semua business logic (currentStage,
 * stageOwner, nextAction, SLA, aging, priorityLevel/Score, rejectCategory,
 * isQRISIssued, isMerchantBacklog, isInternalBacklog) tetap 100% dihitung
 * backend (warroom-qris-control-tower.js) — tidak disentuh sama sekali di
 * refactor ini, cuma dikonsumsi apa adanya lewat field record.*.
 *
 * Route TETAP /war-room/qris-control-tower — tidak ada route baru.
 */
export default function WarRoomQrisControlTower() {
  const [data,        setData]    = useState(null);
  const [loading,     setLoading] = useState(true);
  const [error,       setError]   = useState(null);
  const [lastUpdated, setLastUpd] = useState(null);
  const [selected,    setSelected] = useState(null);
  const [toast, showToast] = useQrisToast();
  const handleAction = useMemo(() => createQrisActionHandler(showToast), [showToast]);

  // Tab aktif — sinkron ke query param ?tab= (opsional, fallback ke local state)
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = QRIS_TABS.some(t => t.key === searchParams.get('tab')) ? searchParams.get('tab') : 'command';
  const [activeTab, setActiveTab] = useState(initialTab);
  const changeTab = useCallback((key) => {
    setActiveTab(key);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', key);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Filter GLOBAL — muncul di semua tab (date range Tanggal_Registrasi + search)
  const [globalFilter, setGlobalFilter] = useState({ dateFrom: '', dateTo: '', search: '' });
  const setGlobal = (key, value) => setGlobalFilter(prev => ({ ...prev, [key]: value }));
  const resetGlobal = () => setGlobalFilter({ dateFrom: '', dateTo: '', search: '' });
  const isGlobalFiltered = globalFilter.dateFrom || globalFilter.dateTo || globalFilter.search;

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await getQrisControlTowerAnalytics();
      setData(res);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Gagal memuat data');
    } finally { setLoading(false); setLastUpd(new Date()); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const allRecords = data?.records || [];

  // records SUDAH difilter global — inilah "satu sumber data" yang dioper
  // ke semua tab (tiap tab tinggal filter tambahan sesuai kebutuhannya).
  const records = useMemo(() => {
    let rows = allRecords;
    if (globalFilter.dateFrom) rows = rows.filter(r => r.tanggalRegistrasi && r.tanggalRegistrasi.slice(0, 10) >= globalFilter.dateFrom);
    if (globalFilter.dateTo)   rows = rows.filter(r => r.tanggalRegistrasi && r.tanggalRegistrasi.slice(0, 10) <= globalFilter.dateTo);
    if (globalFilter.search.trim()) {
      const q = globalFilter.search.trim().toLowerCase();
      rows = rows.filter(r => r.idOutlet.toLowerCase().includes(q) || (r.namaOutlet || '').toLowerCase().includes(q));
    }
    return rows;
  }, [allRecords, globalFilter]);

  // Badge count tab — dihitung dari `records` (setelah filter global), bukan
  // dari raw fetch, supaya konsisten dengan apa yang user lihat di tiap tab.
  const badges = useMemo(() => {
    const metrics = aggregateMetrics(records);
    return {
      queue:        countByPriorities(records, ['P0', 'P1']),
      sla:          metrics.totalOverSLA,
      merchant:     metrics.totalMerchantBacklog,
      verification: metrics.totalInternalBacklog,
      reject:       metrics.totalRejected,
    };
  }, [records]);

  const tabProps = { records, onSelectRow: setSelected, onAction: handleAction };

  return (
    <Layout>
      <div className="wr-page wrqris-page">

        <div className="wr-header wrqris-header">
          <div>
            <div className="wr-title-row">
              <span className="wr-icon" style={{ color: ACCENT }}>
                <i className="ti ti-radar" style={{ fontSize: 24 }} />
              </span>
              <h1 className="wr-title">QRIS Issuance Control Tower</h1>
              <span className="war-badge" style={{ background: ACCENT }}>CONTROL TOWER</span>
            </div>
            <p className="wr-sub">
              Monitoring pendaftaran QRIS dari registrasi sampai PTEN approve agar outlet cepat terbit.
              {data?.last_sync && <span style={{ marginLeft: 8 }}>· Sync terakhir {fmtDateTime(data.last_sync)}</span>}
              {lastUpdated && (
                <span style={{ marginLeft: 8, color: 'var(--text-4)' }}>
                  · Dimuat {lastUpdated.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              )}
            </p>
          </div>
          <div className="wr-header-right">
            <button className="wr-btn-update" onClick={fetchData} disabled={loading}>
              {loading
                ? <><i className="ti ti-loader-2" style={{ animation: 'aic-rotate 0.8s linear infinite' }} /> Memuat...</>
                : <><i className="ti ti-refresh" /> Update Data</>
              }
            </button>
          </div>
        </div>

        {error && !loading && (
          <div className="wr-error">
            <i className="ti ti-alert-circle" /> {error}
            <button className="wr-btn-retry" onClick={fetchData}>Coba Lagi</button>
          </div>
        )}

        {loading && !data && <SkeletonCards />}

        {!loading && data?.empty && (
          <div className="empty-state">
            <div className="empty-icon">📭</div>
            <div className="empty-title">Belum ada data</div>
            <div className="empty-sub">Sync dari Apps Script belum berjalan untuk sheet Penerbitan QRIS (Data Merchant, KYCKYM, VerifikasiOP, PTEN)</div>
          </div>
        )}

        {!loading && data && !data.empty && (
          <>
            <QrisFilterBar
              fields={[
                { key: 'date', type: 'daterange', label: 'Registrasi' },
                { key: 'search', type: 'search', placeholder: '🔍 Cari ID Outlet / Nama Outlet...' },
              ]}
              values={{ dateFrom: globalFilter.dateFrom, dateTo: globalFilter.dateTo, search: globalFilter.search }}
              onChange={setGlobal}
              onReset={resetGlobal}
              isFiltered={isGlobalFiltered}
              resultCount={records.length}
              resultLabel="outlet (setelah filter global)"
            />

            <QrisTabNav activeTab={activeTab} onChange={changeTab} badges={badges} />

            <div className="wrqris-tab-content">
              {activeTab === 'command'      && <QrisCommandCenterTab {...tabProps} />}
              {activeTab === 'queue'        && <QrisSmartQueueTab {...tabProps} />}
              {activeTab === 'sla'          && <QrisSlaAgingTab {...tabProps} />}
              {activeTab === 'merchant'     && <QrisMerchantFollowUpTab {...tabProps} />}
              {activeTab === 'verification' && <QrisVerificationPtenTab {...tabProps} />}
              {activeTab === 'reject'       && <QrisRejectBottleneckTab {...tabProps} />}
              {activeTab === 'audit'        && <QrisRawAuditTab records={records} onSelectRow={setSelected} />}
            </div>
          </>
        )}

      </div>
      <QrisOutletDetailDrawer record={selected} onClose={() => setSelected(null)} onAction={handleAction} />
      <QrisToast toast={toast} />
    </Layout>
  );
}
