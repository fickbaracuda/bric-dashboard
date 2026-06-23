import { useState, useEffect, useCallback, useRef } from 'react';
import Layout from '../components/Layout';
import { getToken } from '../utils/auth';

const API = import.meta.env.VITE_API_URL || '';

const APPS_SCRIPT = `// ============================================================
// BRIC Dashboard — Sync Data Raw Outlet InstaQris
// Paste ke Extensions → Apps Script di Google Sheets outlet
// Jalankan fungsi: syncSemuaSheet()
// ============================================================
const VPS_URL    = 'http://147.139.201.43/api/data-raw/outlet/sync';
const SYNC_TOKEN = 'bric2026bimasaktisecret';

function syncSemuaSheet() {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheets  = ss.getSheets();
  const results = [];

  for (const sheet of sheets) {
    const sheetName = sheet.getName();
    const bulan     = parseBulan(sheetName);
    if (!bulan) {
      results.push('⏭ Skip "' + sheetName + '" (tidak bisa parse bulan)');
      continue;
    }

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2) {
      results.push('⏭ Skip "' + sheetName + '" (data kosong)');
      continue;
    }

    const data    = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    const headers = data[0].map(function(h) { return String(h).trim(); });

    // Indeks kolom dengan header tidak kosong
    const validIdx = [];
    headers.forEach(function(h, i) { if (h) validIdx.push(i); });
    const cleanHdr = validIdx.map(function(i) { return headers[i]; });

    const rows = [];
    for (var r = 1; r < data.length; r++) {
      const row = data[r];
      // Skip baris di mana semua kolom valid kosong
      const hasVal = validIdx.some(function(i) { return row[i] !== '' && row[i] != null; });
      if (!hasVal) continue;

      const obj = {};
      validIdx.forEach(function(colIdx, ci) {
        let v = row[colIdx];
        if (v instanceof Date) {
          v = Utilities.formatDate(v, 'Asia/Jakarta', 'yyyy-MM-dd');
        } else if (v === undefined || v === null) {
          v = '';
        }
        obj[cleanHdr[ci]] = v;
      });
      rows.push(obj);
    }

    if (rows.length === 0) {
      results.push('⏭ Skip "' + sheetName + '" (semua baris kosong)');
      continue;
    }

    try {
      const resp = UrlFetchApp.fetch(VPS_URL, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ token: SYNC_TOKEN, bulan: bulan, sheet_name: sheetName, rows: rows }),
        muteHttpExceptions: true,
      });
      const body = JSON.parse(resp.getContentText());
      if (body.ok) {
        results.push('✅ "' + sheetName + '" → ' + bulan + ' (' + body.rows_inserted + ' baris, ' + body.duration_ms + 'ms)');
      } else {
        results.push('❌ "' + sheetName + '" → ERROR: ' + JSON.stringify(body));
      }
    } catch (e) {
      results.push('❌ "' + sheetName + '" → Exception: ' + e.message);
    }

    Utilities.sleep(300);
  }

  SpreadsheetApp.getUi().alert('Hasil Sync:\\n\\n' + results.join('\\n'));
}

// Deteksi bulan dari nama sheet tab
// Contoh: "April 2026" → "2026-04", "Apr 2026" → "2026-04"
function parseBulan(name) {
  const MONTH = {
    januari:1, jan:1, februari:2, feb:2, maret:3, mar:3,
    april:4, apr:4, mei:5, may:5, juni:6, jun:6,
    juli:7, jul:7, agustus:8, agt:8, aug:8,
    september:9, sep:9, oktober:10, okt:10, oct:10,
    november:11, nov:11, desember:12, des:12, dec:12
  };
  const lower = name.toLowerCase().replace(/[^a-z0-9\\s]/g, ' ');
  const yr    = (name.match(/\\b(20\\d{2})\\b/) || [])[1];
  if (!yr) return null;
  for (const k in MONTH) {
    if (lower.indexOf(k) !== -1) return yr + '-' + String(MONTH[k]).padStart(2, '0');
  }
  // Format "MM/YYYY" atau "MM-YYYY"
  const m = name.match(/\\b(\\d{1,2})[\\/-](20\\d{2})\\b/);
  if (m) return m[2] + '-' + m[1].padStart(2, '0');
  return null;
}`;

function fmtBulan(b) {
  if (!b) return '-';
  const [y, m] = b.split('-');
  const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
  return `${months[parseInt(m, 10) - 1] || m} ${y}`;
}

export default function DataRaw() {
  const [activeTab, setActiveTab] = useState('outlet');

  return (
    <Layout>
      <div className="dr-page">
        <div className="dr-header">
          <div className="dr-header-title">
            <i className="ti ti-database" />
            Data Raw
          </div>
        </div>

        <div className="dr-tabs">
          <button
            className={`dr-tab${activeTab === 'outlet' ? ' dr-tab--active' : ''}`}
            onClick={() => setActiveTab('outlet')}
          >
            <i className="ti ti-building-store" />
            Data Outlet
          </button>
        </div>

        {activeTab === 'outlet' && <OutletTab />}
      </div>
    </Layout>
  );
}

function OutletTab() {
  const [bulanList,     setBulanList]     = useState([]);
  const [selectedBulan, setSelectedBulan] = useState('');
  const [search,        setSearch]        = useState('');
  const [rows,          setRows]          = useState([]);
  const [columns,       setColumns]       = useState([]);
  const [total,         setTotal]         = useState(0);
  const [page,          setPage]          = useState(1);
  const [loading,       setLoading]       = useState(false);
  const [showScript,    setShowScript]    = useState(false);
  const PER_PAGE = 200;
  const searchTimer = useRef(null);

  const fetchData = useCallback(async (bulan, q, pg) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: pg, per_page: PER_PAGE });
      if (bulan) params.set('bulan', bulan);
      if (q)     params.set('q', q);
      const res  = await fetch(`${API}/api/data-raw/outlet?${params}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      const data = await res.json();
      setRows(data.rows || []);
      setColumns(data.columns || []);
      setTotal(parseInt(data.total) || 0);
      if (data.bulan_list?.length) setBulanList(data.bulan_list);
    } catch { /* network error */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData('', '', 1); }, [fetchData]);

  function handleBulan(v)  { setSelectedBulan(v); setPage(1); fetchData(v, search, 1); }
  function handleSearch(v) {
    setSearch(v);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { setPage(1); fetchData(selectedBulan, v, 1); }, 450);
  }
  function gotoPage(pg)    { setPage(pg); fetchData(selectedBulan, search, pg); }

  const totalPages = Math.ceil(total / PER_PAGE);

  return (
    <div className="dr-outlet-wrap">
      {/* Toolbar */}
      <div className="dr-toolbar">
        <div className="dr-toolbar-left">
          <select
            className="dr-select"
            value={selectedBulan}
            onChange={e => handleBulan(e.target.value)}
          >
            <option value="">Semua Bulan</option>
            {bulanList.map(b => (
              <option key={b.bulan} value={b.bulan}>
                {fmtBulan(b.bulan)} — {b.sheet_name} ({Number(b.row_count).toLocaleString()} baris)
              </option>
            ))}
          </select>

          <div className="dr-search-wrap">
            <i className="ti ti-search" />
            <input
              className="dr-search"
              placeholder="Cari ID Outlet, Nama, Kota…"
              value={search}
              onChange={e => handleSearch(e.target.value)}
            />
            {search && (
              <button className="dr-search-clear" onClick={() => handleSearch('')}>
                <i className="ti ti-x" />
              </button>
            )}
          </div>
        </div>

        <div className="dr-toolbar-right">
          <span className="dr-total-label">
            {loading ? 'Memuat…' : `${total.toLocaleString()} baris`}
          </span>
          <button className="dr-btn-script" onClick={() => setShowScript(true)}>
            <i className="ti ti-brand-google" />
            Apps Script
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="dr-table-wrap">
        {loading ? (
          <div className="dr-loading">
            <i className="ti ti-loader-2 dr-spinner" />
            Memuat data…
          </div>
        ) : rows.length === 0 ? (
          <div className="dr-empty">
            <i className="ti ti-database-off" />
            <div className="dr-empty-title">Belum ada data</div>
            <div className="dr-empty-sub">
              Klik <strong>Apps Script</strong> di kanan atas, paste ke Google Sheets,
              lalu jalankan <code>syncSemuaSheet()</code>
            </div>
          </div>
        ) : (
          <table className="dr-table">
            <thead>
              <tr>
                <th className="dr-th-no">#</th>
                {columns.map(col => <th key={col}>{col}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <td className="dr-td-no">{(page - 1) * PER_PAGE + i + 1}</td>
                  {columns.map(col => (
                    <td key={col}>{row[col] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="dr-pagination">
          <button className="dr-page-btn" disabled={page <= 1} onClick={() => gotoPage(page - 1)}>
            <i className="ti ti-chevron-left" />
          </button>
          <span className="dr-page-info">Hal {page} / {totalPages}</span>
          <button className="dr-page-btn" disabled={page >= totalPages} onClick={() => gotoPage(page + 1)}>
            <i className="ti ti-chevron-right" />
          </button>
        </div>
      )}

      {showScript && <ScriptModal onClose={() => setShowScript(false)} />}
    </div>
  );
}

function ScriptModal({ onClose }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(APPS_SCRIPT).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  return (
    <div className="dr-modal-overlay" onClick={onClose}>
      <div className="dr-modal" onClick={e => e.stopPropagation()}>
        <div className="dr-modal-head">
          <div className="dr-modal-title">
            <i className="ti ti-brand-google" />
            Apps Script — Sync Data Outlet ke BRIC
          </div>
          <button className="dr-modal-close" onClick={onClose}>
            <i className="ti ti-x" />
          </button>
        </div>

        <div className="dr-modal-body">
          <div className="dr-script-info">
            <i className="ti ti-info-circle" />
            <div>
              Buka Google Sheets → <strong>Extensions → Apps Script</strong> → paste kode ini → Save → Run <code>syncSemuaSheet()</code>.
              <br />Setiap tab sheet (mis: "April 2026", "Mei 2026") akan terdeteksi otomatis sebagai bulan.
            </div>
          </div>
          <pre className="dr-script-code">{APPS_SCRIPT}</pre>
        </div>

        <div className="dr-modal-foot">
          <button className="dr-btn-copy" onClick={copy}>
            <i className={`ti ${copied ? 'ti-check' : 'ti-copy'}`} />
            {copied ? 'Tersalin!' : 'Salin Kode'}
          </button>
          <button className="dr-btn-close2" onClick={onClose}>Tutup</button>
        </div>
      </div>
    </div>
  );
}
