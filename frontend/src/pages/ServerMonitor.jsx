import { useState, useEffect, useRef, useCallback } from 'react';
import Layout from '../components/Layout';
import { getSystemStats } from '../services/api';

const COLOR  = '#6366F1';
const SPIN   = { animation: 'aic-rotate 0.8s linear infinite' };
const INTERVAL = 15; // detik

/* ── Format helpers ── */
function fmtBytes(b) {
  if (!b) return '–';
  const n = Number(b);
  if (n >= 1e9)  return (n / 1e9).toFixed(1)  + ' GB';
  if (n >= 1e6)  return (n / 1e6).toFixed(1)  + ' MB';
  if (n >= 1e3)  return (n / 1e3).toFixed(1)  + ' KB';
  return n + ' B';
}
function fmtUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}h ${h}j ${m}m`;
  if (h > 0) return `${h}j ${m}m`;
  return `${m}m ${s % 60}d`;
}
function fmtDuration(s) {
  if (s == null) return '–';
  const sec = Number(s);
  if (sec < 60)   return `${sec}d`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}d`;
  return `${Math.floor(sec / 3600)}j ${Math.floor((sec % 3600) / 60)}m`;
}
function fmtDate(d) { return d ? String(d).slice(0, 10) : '–'; }
function pct(used, total) { return total > 0 ? Math.round(used / total * 100) : 0; }

/* ── Gauge bar ── */
function Gauge({ value, max = 100, color, label, sub }) {
  const p = Math.min(pct(value, max), 100);
  const c = p >= 90 ? '#DC2626' : p >= 70 ? '#F59E0B' : color || COLOR;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
        <span style={{ color: 'var(--text-2)', fontWeight: 600 }}>{label}</span>
        <span style={{ fontWeight: 700, color: c }}>{p}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${p}%`, background: c, borderRadius: 4, transition: 'width .4s' }} />
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-4)' }}>{sub}</div>}
    </div>
  );
}

/* ── KPI Card ── */
function KPI({ label, value, sub, color, icon }) {
  return (
    <div className="wrd-kpi-card" style={{ borderTop: `3px solid ${color || COLOR}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="wrd-kpi-label">{label}</div>
        {icon && <i className={`ti ${icon}`} style={{ fontSize: 18, color: (color || COLOR) + '88' }} />}
      </div>
      <div className="wrd-kpi-value" style={{ color: color || COLOR }}>{value}</div>
      {sub && <div className="wrd-kpi-sub">{sub}</div>}
    </div>
  );
}

/* ── Status dot ── */
function Dot({ ok }) {
  return <span style={{
    display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
    background: ok ? '#10B981' : '#DC2626',
    boxShadow: ok ? '0 0 6px #10B98166' : '0 0 6px #DC262666',
    marginRight: 6,
  }} />;
}

/* ── Query state badge ── */
function StateBadge({ state }) {
  const colors = { active: '#059669', idle: '#9CA3AF', 'idle in transaction': '#F59E0B', 'idle in transaction (aborted)': '#DC2626' };
  const c = colors[state] || '#6B7280';
  return <span className="wrd-badge" style={{ background: c + '20', color: c, fontSize: 10 }}>{state}</span>;
}

/* ════════════════════════════════════════
   MAIN COMPONENT
════════════════════════════════════════ */
export default function ServerMonitor() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [tick,    setTick]    = useState(INTERVAL);
  const [lastAt,  setLastAt]  = useState(null);
  const timerRef = useRef(null);
  const tickRef  = useRef(null);

  const fetch = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const json = await getSystemStats();
      setData(json);
      setLastAt(new Date());
      setTick(INTERVAL);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + auto-refresh
  useEffect(() => {
    fetch();
    timerRef.current = setInterval(() => fetch(true), INTERVAL * 1000);
    tickRef.current  = setInterval(() => setTick(t => Math.max(0, t - 1)), 1000);
    return () => { clearInterval(timerRef.current); clearInterval(tickRef.current); };
  }, [fetch]);

  const sv = data?.server;
  const db = data?.database;

  const cpuPct   = sv ? Math.min(Math.round(sv.load_1 / sv.cpu_count * 100), 100) : 0;
  const memPct   = sv ? pct(sv.mem_used, sv.mem_total) : 0;
  const diskPct  = sv?.disk ? pct(sv.disk.used, sv.disk.total) : 0;
  const nodePct  = sv ? pct(sv.node_heap_used, sv.node_heap_total) : 0;
  const connPct  = db ? pct(db.conn_total, db.conn_max) : 0;

  return (
    <Layout>
      <div className="wr-page">

        {/* ── Header ── */}
        <div className="wr-header">
          <div>
            <div className="wr-title-row">
              <i className="ti ti-server-2" style={{ fontSize: 22, color: COLOR }} />
              <h1 className="wr-title" style={{ color: COLOR }}>SERVER MONITOR</h1>
              {data && (
                <span style={{ display: 'flex', alignItems: 'center', fontSize: 12, color: 'var(--text-4)', marginLeft: 12 }}>
                  <Dot ok={!error} />
                  {error ? 'Error' : 'Live'}
                </span>
              )}
            </div>
            <p className="wr-sub">
              Performa real-time server & database
              {lastAt && <> · Diperbarui {lastAt.toLocaleTimeString('id-ID')} · refresh dalam <strong style={{ color: COLOR }}>{tick}d</strong></>}
            </p>
          </div>
          <div className="wr-header-right">
            <button className="wr-btn-update" onClick={() => fetch()} disabled={loading}
              style={{ padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <i className="ti ti-refresh" style={loading ? SPIN : undefined} />
              {loading ? 'Memuat…' : 'Refresh'}
            </button>
          </div>
        </div>

        {error && (
          <div className="wrfp-error" style={{ marginBottom: 16 }}>
            <i className="ti ti-alert-circle" />
            <span>{error}</span>
          </div>
        )}

        {!data && loading && (
          <div className="wrfp-loading">
            <i className="ti ti-loader-2" style={SPIN} />
            <span>Mengambil data server…</span>
          </div>
        )}

        {data && (
          <>
            {/* ── SERVER KPIs ── */}
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-4)', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>
              <i className="ti ti-server" style={{ marginRight: 6 }} />Server
            </div>
            <div className="wrd-kpi-grid wrd-kpi-grid-4" style={{ marginBottom: 16 }}>
              <KPI label="CPU Load (1m)" icon="ti-cpu"
                value={`${cpuPct}%`}
                sub={`Load: ${sv.load_1.toFixed(2)} / ${sv.load_5.toFixed(2)} / ${sv.load_15.toFixed(2)} · ${sv.cpu_count} core`}
                color={cpuPct >= 90 ? '#DC2626' : cpuPct >= 70 ? '#F59E0B' : '#059669'} />
              <KPI label="Memory Server" icon="ti-memory"
                value={`${memPct}%`}
                sub={`${fmtBytes(sv.mem_used)} / ${fmtBytes(sv.mem_total)} terpakai`}
                color={memPct >= 90 ? '#DC2626' : memPct >= 70 ? '#F59E0B' : COLOR} />
              <KPI label="Disk (/)" icon="ti-device-floppy"
                value={sv.disk ? `${diskPct}%` : '–'}
                sub={sv.disk ? `${fmtBytes(sv.disk.used)} / ${fmtBytes(sv.disk.total)} terpakai` : 'Tidak tersedia'}
                color={diskPct >= 90 ? '#DC2626' : diskPct >= 80 ? '#F59E0B' : COLOR} />
              <KPI label="Uptime Server" icon="ti-clock"
                value={fmtUptime(sv.os_uptime_s)}
                sub={`Node.js: ${fmtUptime(sv.uptime_s)}`}
                color={COLOR} />
            </div>

            {/* ── Gauge bars ── */}
            <div className="wrd-charts-row" style={{ marginBottom: 16 }}>
              <div className="wrd-chart-card">
                <div className="wrd-chart-head"><span className="wrd-chart-title">Utilisasi Server</span></div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0' }}>
                  <Gauge value={cpuPct}  label="CPU (load avg)" sub={`${sv.cpu_count} core · model: ${sv.cpu_model.slice(0, 40)}`} color="#059669" />
                  <Gauge value={memPct}  label="RAM Server"      sub={`${fmtBytes(sv.mem_used)} dipakai, ${fmtBytes(sv.mem_free)} bebas`} color={COLOR} />
                  {sv.disk && <Gauge value={diskPct} label="Disk (/)" sub={`${fmtBytes(sv.disk.used)} dipakai, ${fmtBytes(sv.disk.free)} bebas`} color="#F97316" />}
                </div>
              </div>
              <div className="wrd-chart-card">
                <div className="wrd-chart-head"><span className="wrd-chart-title">Node.js Process</span></div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0' }}>
                  <Gauge value={sv.node_heap_used} max={sv.mem_total}
                    label="Heap vs RAM Server"
                    sub={`${fmtBytes(sv.node_heap_used)} heap / ${fmtBytes(sv.node_heap_total)} dialokasikan V8 · normal jika < heap_total`}
                    color={COLOR} />
                  <Gauge value={pct(sv.node_rss, sv.mem_total)} label="RSS (total memory proses)" sub={fmtBytes(sv.node_rss)} color="#8B5CF6" />
                </div>
                <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    { label: 'Heap Used',  val: fmtBytes(sv.node_heap_used) },
                    { label: 'Heap Total', val: fmtBytes(sv.node_heap_total) },
                    { label: 'RSS',        val: fmtBytes(sv.node_rss) },
                    { label: 'Uptime Node', val: fmtUptime(sv.uptime_s) },
                  ].map((item, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '5px 10px', background: 'var(--bg-page)', borderRadius: 6 }}>
                      <span style={{ color: 'var(--text-3)' }}>{item.label}</span>
                      <span style={{ fontWeight: 600, color: 'var(--text-1)' }}>{item.val}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* ── DATABASE KPIs ── */}
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-4)', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>
              <i className="ti ti-database" style={{ marginRight: 6 }} />Database PostgreSQL
            </div>
            <div className="wrd-kpi-grid wrd-kpi-grid-4" style={{ marginBottom: 16 }}>
              <KPI label="Ukuran Database" icon="ti-database"
                value={db.size_pretty}
                sub={fmtBytes(db.size_bytes)}
                color={COLOR} />
              <KPI label="Koneksi Aktif" icon="ti-plug-connected"
                value={db.conn_active}
                sub={`${db.conn_idle} idle · ${db.conn_total} total`}
                color={db.conn_active > 10 ? '#F59E0B' : '#059669'} />
              <KPI label="Koneksi (Total / Max)" icon="ti-topology-ring"
                value={`${db.conn_total} / ${db.conn_max}`}
                sub={`${connPct}% kapasitas terpakai`}
                color={connPct >= 80 ? '#DC2626' : connPct >= 60 ? '#F59E0B' : '#059669'} />
              <KPI label="Lock Waiting" icon="ti-lock"
                value={db.lock_waiting}
                sub={db.lock_waiting > 0 ? 'Ada query yang menunggu lock!' : 'Tidak ada lock conflict'}
                color={db.lock_waiting > 0 ? '#DC2626' : '#059669'} />
            </div>

            {/* ── Connection gauge ── */}
            <div className="wrd-chart-card" style={{ marginBottom: 16 }}>
              <div className="wrd-chart-head"><span className="wrd-chart-title">Koneksi Database</span></div>
              <Gauge value={db.conn_total} max={db.conn_max}
                label={`${db.conn_total} / ${db.conn_max} koneksi`}
                sub={`Active: ${db.conn_active} · Idle: ${db.conn_idle} · Max allowed: ${db.conn_max}`}
                color={COLOR} />
            </div>

            {/* ── Tables + Active queries ── */}
            <div className="wrd-charts-row">
              {/* Table sizes */}
              <div className="wrd-chart-card">
                <div className="wrd-chart-head"><span className="wrd-chart-title">Ukuran Tabel (Top 12)</span></div>
                <div className="wr-table-wrap" style={{ maxHeight: 380 }}>
                  <table className="wr-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Tabel</th>
                        <th style={{ textAlign: 'right' }}>Ukuran</th>
                        <th style={{ textAlign: 'right' }}>Rows</th>
                        <th style={{ textAlign: 'right' }}>Dead Rows</th>
                        <th>Last Vacuum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(db.tables || []).map((t, i) => {
                        const maxBytes = Number(db.tables[0]?.size_bytes) || 1;
                        const barPct   = Math.round(Number(t.size_bytes) / maxBytes * 100);
                        return (
                          <tr key={t.table_name}>
                            <td style={{ color: 'var(--text-4)', width: 24 }}>{i + 1}</td>
                            <td>
                              <code style={{ fontSize: 11, color: COLOR }}>{t.table_name}</code>
                              <div style={{ height: 3, borderRadius: 2, background: 'var(--border)', marginTop: 3, overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: barPct + '%', background: COLOR + '88' }} />
                              </div>
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: 700 }}>{t.size_pretty}</td>
                            <td style={{ textAlign: 'right' }}>{Number(t.rows).toLocaleString('id-ID')}</td>
                            <td style={{ textAlign: 'right', color: Number(t.dead_rows) > 10000 ? '#F59E0B' : 'var(--text-4)' }}>
                              {Number(t.dead_rows).toLocaleString('id-ID')}
                            </td>
                            <td style={{ fontSize: 11, color: 'var(--text-4)' }}>
                              {t.last_autovacuum ? fmtDate(t.last_autovacuum) : (t.last_vacuum ? fmtDate(t.last_vacuum) : '–')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Active queries */}
              <div className="wrd-chart-card">
                <div className="wrd-chart-head"><span className="wrd-chart-title">Query Aktif / Running</span></div>
                {db.active_queries.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-4)' }}>
                    <i className="ti ti-check" style={{ fontSize: 28, display: 'block', marginBottom: 8, color: '#10B981' }} />
                    Tidak ada query aktif
                  </div>
                ) : (
                  <div className="wr-table-wrap" style={{ maxHeight: 380 }}>
                    <table className="wr-table">
                      <thead>
                        <tr>
                          <th>PID</th>
                          <th>State</th>
                          <th style={{ textAlign: 'right' }}>Durasi</th>
                          <th>Wait</th>
                          <th>Query</th>
                        </tr>
                      </thead>
                      <tbody>
                        {db.active_queries.map((q, i) => (
                          <tr key={q.pid + i}>
                            <td><code style={{ fontSize: 11 }}>{q.pid}</code></td>
                            <td><StateBadge state={q.state} /></td>
                            <td style={{ textAlign: 'right', fontWeight: 700, color: q.duration_s > 10 ? '#DC2626' : q.duration_s > 3 ? '#F59E0B' : 'var(--text-1)' }}>
                              {fmtDuration(q.duration_s)}
                            </td>
                            <td style={{ fontSize: 11, color: q.wait_event ? '#F59E0B' : 'var(--text-4)' }}>
                              {q.wait_event || '–'}
                            </td>
                            <td style={{ fontSize: 11, color: 'var(--text-3)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {q.query}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
