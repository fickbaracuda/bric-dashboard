const express      = require('express');
const router       = express.Router();
const pool         = require('../db');
const os           = require('os');
const { execSync } = require('child_process');

function getDisk() {
  try {
    const lines = execSync('df -B1 / 2>/dev/null').toString().trim().split('\n');
    const p = lines[1]?.split(/\s+/);
    if (!p) return null;
    return { total: +p[1], used: +p[2], free: +p[3] };
  } catch { return null; }
}

router.get('/stats', async (req, res) => {
  try {
    const cpus     = os.cpus();
    const loadAvg  = os.loadavg();
    const memTotal = os.totalmem();
    const memFree  = os.freemem();
    const mem      = process.memoryUsage();
    const disk     = getDisk();

    const [dbSizeRes, connRes, maxConnRes, tableRes, activityRes, lockRes] = await Promise.all([
      pool.query(`SELECT pg_size_pretty(pg_database_size('bric')) AS size_pretty,
                         pg_database_size('bric')                  AS size_bytes`),
      pool.query(`SELECT
                    COUNT(*) FILTER (WHERE state = 'active')  AS active,
                    COUNT(*) FILTER (WHERE state = 'idle')    AS idle,
                    COUNT(*)                                   AS total
                  FROM pg_stat_activity WHERE datname = 'bric'`),
      pool.query(`SELECT setting::int AS max FROM pg_settings WHERE name = 'max_connections'`),
      pool.query(`
        SELECT relname                                                AS table_name,
               pg_size_pretty(pg_total_relation_size(relid))        AS size_pretty,
               pg_total_relation_size(relid)                        AS size_bytes,
               n_live_tup                                           AS rows,
               n_dead_tup                                           AS dead_rows,
               last_vacuum, last_autovacuum, last_analyze
        FROM pg_stat_user_tables
        ORDER BY size_bytes DESC
        LIMIT 12`),
      pool.query(`
        SELECT pid,
               usename,
               state,
               EXTRACT(EPOCH FROM (now() - query_start))::int AS duration_s,
               wait_event_type,
               wait_event,
               left(query, 150) AS query
        FROM pg_stat_activity
        WHERE datname = 'bric'
          AND state NOT IN ('idle')
          AND query NOT LIKE '%pg_stat_activity%'
        ORDER BY duration_s DESC NULLS LAST
        LIMIT 15`),
      pool.query(`
        SELECT count(*) AS lock_count
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted`),
    ]);

    const c = connRes.rows[0];
    res.json({
      timestamp: new Date().toISOString(),
      server: {
        uptime_s:    Math.floor(process.uptime()),
        os_uptime_s: Math.floor(os.uptime()),
        cpu_count:   cpus.length,
        cpu_model:   cpus[0]?.model || '',
        load_1:      loadAvg[0],
        load_5:      loadAvg[1],
        load_15:     loadAvg[2],
        mem_total:   memTotal,
        mem_free:    memFree,
        mem_used:    memTotal - memFree,
        node_rss:    mem.rss,
        node_heap_used:  mem.heapUsed,
        node_heap_total: mem.heapTotal,
        disk,
      },
      database: {
        size_pretty:  dbSizeRes.rows[0]?.size_pretty,
        size_bytes:   Number(dbSizeRes.rows[0]?.size_bytes),
        conn_active:  Number(c.active),
        conn_idle:    Number(c.idle),
        conn_total:   Number(c.total),
        conn_max:     Number(maxConnRes.rows[0]?.max),
        lock_waiting: Number(lockRes.rows[0]?.lock_count),
        tables:       tableRes.rows,
        active_queries: activityRes.rows,
      },
    });
  } catch (e) {
    console.error('system stats error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
