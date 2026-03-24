/**
 * LPR Dwell Time Tracker — Server
 *
 * Features:
 *  - SQLite persistence (sessions, events, alerts survive restarts)
 *  - SSE live push to dashboard
 *  - Alta Video API proxy (login + camera discovery, keeps credentials server-side)
 *  - Reports API (daily/weekly summary, top plates, violations)
 *
 * Setup:
 *   npm install express better-sqlite3 node-fetch
 *   node server.js
 *
 * Dashboard:        http://localhost:3000
 * Alta webhook URL: POST http://YOUR_SERVER_IP:3000/webhook/lpr
 * DB file:          ./lpr.db  (auto-created)
 */

'use strict';

const express  = require('express');
const path     = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
  port: 3000,
  dbPath: './lpr.db',
  maxDwellMinutes: 60,
  warnAtPercent: 0.80,
  pollIntervalMs: 15_000,

  // Camera map — populated via camera discovery UI or manually here.
  // key = Alta camera/device ID (GUID), value = { role, label }
  cameras: {},

  notifications: {
    webhookUrl: null,
    console: true,
  },
};

// ── Alta session (server-side only — credentials never leave the server) ───────
let altaSession = {
  baseUrl:  null,   // e.g. https://mysite.eu1.aware.avasecurity.com
  cookie:   null,   // session cookie from dologin
  username: null,
  loggedIn: false,
};

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(CONFIG.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    plate              TEXT    NOT NULL,
    entry_time         TEXT,
    exit_time          TEXT,
    entry_camera       TEXT,
    exit_camera        TEXT,
    status             TEXT    NOT NULL DEFAULT 'active',
    alerted_warning    INTEGER NOT NULL DEFAULT 0,
    alerted_violation  INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (plate, entry_time)
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_plate  ON sessions(plate);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    plate      TEXT NOT NULL,
    camera_id  TEXT NOT NULL,
    role       TEXT NOT NULL,
    confidence REAL,
    ts         TEXT NOT NULL,
    raw        TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    plate      TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS camera_config (
    camera_id  TEXT PRIMARY KEY,
    role       TEXT NOT NULL,
    label      TEXT NOT NULL,
    site       TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Prepared statements ───────────────────────────────────────────────────────
const stmts = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (plate, entry_time, exit_time, entry_camera, exit_camera,
      status, alerted_warning, alerted_violation, updated_at)
    VALUES (@plate, @entry_time, @exit_time, @entry_camera, @exit_camera,
      @status, @alerted_warning, @alerted_violation, datetime('now'))
    ON CONFLICT(plate, entry_time) DO UPDATE SET
      exit_time=excluded.exit_time, exit_camera=excluded.exit_camera,
      status=excluded.status, alerted_warning=excluded.alerted_warning,
      alerted_violation=excluded.alerted_violation, updated_at=datetime('now')
  `),
  getAllActive:    db.prepare(`SELECT * FROM sessions WHERE status IN ('active','warning','violation')`),
  getAllSessions:  db.prepare(`SELECT * FROM sessions ORDER BY COALESCE(entry_time, created_at) DESC LIMIT 500`),
  getViolations:  db.prepare(`SELECT * FROM sessions WHERE status='violation' ORDER BY entry_time DESC`),
  closeSession:   db.prepare(`UPDATE sessions SET status='complete', exit_time=@exit_time, exit_camera=@exit_camera, updated_at=datetime('now') WHERE plate=@plate AND status IN ('active','warning','violation')`),
  markWarning:    db.prepare(`UPDATE sessions SET status='warning', alerted_warning=1, updated_at=datetime('now') WHERE plate=@plate AND entry_time=@entry_time`),
  markViolation:  db.prepare(`UPDATE sessions SET status='violation', alerted_violation=1, updated_at=datetime('now') WHERE plate=@plate AND entry_time=@entry_time`),
  insertEvent:    db.prepare(`INSERT INTO events (plate, camera_id, role, confidence, ts, raw) VALUES (@plate,@camera_id,@role,@confidence,@ts,@raw)`),
  insertAlert:    db.prepare(`INSERT INTO alerts (type, plate, message) VALUES (@type,@plate,@message)`),
  getRecentAlerts:db.prepare(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100`),

  // Camera config persistence
  upsertCamera:   db.prepare(`INSERT INTO camera_config (camera_id, role, label, site, updated_at) VALUES (@camera_id,@role,@label,@site,datetime('now')) ON CONFLICT(camera_id) DO UPDATE SET role=excluded.role, label=excluded.label, site=excluded.site, updated_at=datetime('now')`),
  deleteCamera:   db.prepare(`DELETE FROM camera_config WHERE camera_id=?`),
  getAllCameras:  db.prepare(`SELECT * FROM camera_config ORDER BY label`),

  // Reports
  reportByDay: db.prepare(`
    SELECT date(entry_time) AS day,
      COUNT(*) AS visits,
      COUNT(CASE WHEN status='violation' THEN 1 END) AS violations,
      COUNT(CASE WHEN status='warning'   THEN 1 END) AS warnings,
      ROUND(AVG(CASE WHEN exit_time IS NOT NULL
        THEN (julianday(exit_time)-julianday(entry_time))*1440 END), 1) AS avg_dwell_min,
      ROUND(MAX(CASE WHEN exit_time IS NOT NULL
        THEN (julianday(exit_time)-julianday(entry_time))*1440 END), 1) AS max_dwell_min
    FROM sessions
    WHERE entry_time IS NOT NULL AND entry_time >= datetime('now',@offset)
    GROUP BY day ORDER BY day DESC
  `),
  reportTopPlates: db.prepare(`
    SELECT plate,
      COUNT(*) AS visits,
      COUNT(CASE WHEN status='violation' THEN 1 END) AS violations,
      ROUND(AVG(CASE WHEN exit_time IS NOT NULL
        THEN (julianday(exit_time)-julianday(entry_time))*1440 END),1) AS avg_dwell_min
    FROM sessions
    WHERE entry_time >= datetime('now',@offset)
    GROUP BY plate ORDER BY visits DESC LIMIT 20
  `),
  reportViolations: db.prepare(`
    SELECT plate, entry_time, exit_time,
      ROUND((julianday(COALESCE(exit_time,datetime('now')))-julianday(entry_time))*1440,1) AS dwell_min,
      entry_camera, exit_camera
    FROM sessions
    WHERE status='violation' AND entry_time >= datetime('now',@offset)
    ORDER BY entry_time DESC
  `),
};

// ── Row helpers ───────────────────────────────────────────────────────────────
function rowToSession(row) {
  return {
    plate:            row.plate,
    entryTime:        row.entry_time  ? new Date(row.entry_time)  : null,
    exitTime:         row.exit_time   ? new Date(row.exit_time)   : null,
    entryCamera:      row.entry_camera  || null,
    exitCamera:       row.exit_camera   || null,
    status:           row.status,
    alertedWarning:   !!row.alerted_warning,
    alertedViolation: !!row.alerted_violation,
  };
}
function sessionToRow(s) {
  return {
    plate: s.plate,
    entry_time:  s.entryTime  ? s.entryTime.toISOString()  : null,
    exit_time:   s.exitTime   ? s.exitTime.toISOString()   : null,
    entry_camera: s.entryCamera || null,
    exit_camera:  s.exitCamera  || null,
    status: s.status,
    alerted_warning:   s.alertedWarning   ? 1 : 0,
    alerted_violation: s.alertedViolation ? 1 : 0,
  };
}
function sessionForWire(s) {
  return {
    ...s,
    entryTime:    s.entryTime  ? s.entryTime.toISOString()  : null,
    exitTime:     s.exitTime   ? s.exitTime.toISOString()   : null,
    dwellMinutes: dwellMinutes(s),
  };
}

// ── Camera config (load from DB into CONFIG.cameras on boot) ──────────────────
function loadCamerasFromDB() {
  for (const row of stmts.getAllCameras.all()) {
    CONFIG.cameras[row.camera_id] = { role: row.role, label: row.label, site: row.site || '' };
  }
  console.log(`[DB] Loaded ${Object.keys(CONFIG.cameras).length} camera(s)`);
}

// ── Active session cache ──────────────────────────────────────────────────────
const activeCache = new Map();
function loadActiveIntoCache() {
  for (const row of stmts.getAllActive.all()) {
    activeCache.set(row.plate, rowToSession(row));
  }
  console.log(`[DB] Resumed ${activeCache.size} active session(s)`);
}

// ── SSE ───────────────────────────────────────────────────────────────────────
const sseClients = new Set();
function push(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  }
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  res.write(`event: snapshot\ndata: ${JSON.stringify(getSnapshot())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function getSnapshot() {
  return {
    sessions:  stmts.getAllSessions.all().map(r => sessionForWire(rowToSession(r))),
    config:    { maxDwellMinutes: CONFIG.maxDwellMinutes, warnAtPercent: CONFIG.warnAtPercent },
    cameras:   CONFIG.cameras,
    altaStatus: { loggedIn: altaSession.loggedIn, baseUrl: altaSession.baseUrl, username: altaSession.username },
    timestamp: new Date().toISOString(),
  };
}

// ── Alta webhook ──────────────────────────────────────────────────────────────
app.post('/webhook/lpr', (req, res) => {
  if (CONFIG.notifications.console) console.log('[ALTA WEBHOOK]', JSON.stringify(req.body));
  const event = normaliseAltaPayload(req.body);
  if (!event) return res.status(400).json({ error: 'Unrecognised payload shape' });
  res.json(processLPREvent(event, JSON.stringify(req.body)));
});

function normaliseAltaPayload(body) {
  if (body.event === 'lpr.read' || body.event === 'lpr_read')
    return { plate: body.plate, camera_id: body.camera_id, timestamp: body.timestamp, confidence: body.confidence };
  if (body.type === 'LPR' && body.data)
    return { plate: body.data.plate_number, camera_id: body.data.device_id, timestamp: body.data.occurred_at };
  if (body.plate_number || body.plate)
    return { plate: body.plate_number || body.plate, camera_id: body.camera_id || body.device_id, timestamp: body.timestamp };
  return null;
}

// ── Core LPR processor ────────────────────────────────────────────────────────
function processLPREvent({ plate, camera_id, timestamp, confidence = 1 }, rawJson = null) {
  plate = (plate || '').toUpperCase().trim();
  if (!plate) return { ok: false, error: 'Missing plate' };
  const cam = CONFIG.cameras[camera_id];
  if (!cam) { console.warn(`[LPR] Unknown camera: ${camera_id}`); return { ok: false, error: `Unknown camera: ${camera_id}` }; }

  const ts = timestamp ? new Date(timestamp) : new Date();
  stmts.insertEvent.run({ plate, camera_id, role: cam.role, confidence, ts: ts.toISOString(), raw: rawJson });

  if (cam.role === 'entry') {
    const existing = activeCache.get(plate);
    if (existing) {
      console.log(`[LPR] ${plate} re-read at entry (already on site)`);
      push('lpr_read', { plate, role: 'entry', camera: cam.label, duplicate: true, ts: ts.toISOString() });
    } else {
      const session = { plate, entryTime: ts, exitTime: null, entryCamera: camera_id, exitCamera: null, status: 'active', alertedWarning: false, alertedViolation: false };
      stmts.upsertSession.run(sessionToRow(session));
      activeCache.set(plate, session);
      console.log(`[LPR] ✅ ${plate} ENTERED via ${cam.label}`);
      push('session_update', sessionForWire(session));
    }
  } else if (cam.role === 'exit') {
    const session = activeCache.get(plate);
    if (session) {
      session.exitTime = ts; session.exitCamera = camera_id; session.status = 'complete';
      stmts.upsertSession.run(sessionToRow(session));
      activeCache.delete(plate);
      const mins = dwellMinutes(session);
      const over = mins > CONFIG.maxDwellMinutes;
      console.log(`[LPR] 🚗 ${plate} EXITED — ${fmtDuration(mins)} ${over ? '⚠️ EXCEEDED' : '✅'}`);
      push('session_update', sessionForWire(session));
      if (over) notify('violation', session);
    } else {
      const session = { plate, entryTime: null, exitTime: ts, entryCamera: null, exitCamera: camera_id, status: 'complete', alertedWarning: false, alertedViolation: false };
      stmts.upsertSession.run(sessionToRow(session));
      push('session_update', sessionForWire(session));
    }
  }
  return { ok: true, plate, role: cam.role };
}

// ── Background violation checker ──────────────────────────────────────────────
setInterval(() => {
  const now = new Date(), warnAt = CONFIG.maxDwellMinutes * CONFIG.warnAtPercent;
  for (const [, s] of activeCache) {
    if (!s.entryTime) continue;
    const mins = (now - s.entryTime) / 60000;
    if (mins >= CONFIG.maxDwellMinutes && !s.alertedViolation) {
      s.alertedViolation = true; s.status = 'violation';
      stmts.markViolation.run({ plate: s.plate, entry_time: s.entryTime.toISOString() });
      console.log(`[VIOLATION] 🚨 ${s.plate} on site ${fmtDuration(mins)}`);
      notify('violation', s); push('session_update', sessionForWire(s));
    } else if (mins >= warnAt && !s.alertedWarning) {
      s.alertedWarning = true; s.status = 'warning';
      stmts.markWarning.run({ plate: s.plate, entry_time: s.entryTime.toISOString() });
      console.log(`[WARNING] ⚠️  ${s.plate} on site ${fmtDuration(mins)}`);
      notify('warning', s); push('session_update', sessionForWire(s));
    }
  }
  push('tick', { ts: now.toISOString() });
}, CONFIG.pollIntervalMs);

// ── Notifications ─────────────────────────────────────────────────────────────
async function notify(type, session) {
  const mins = dwellMinutes(session);
  const payload = { type, plate: session.plate, entryTime: session.entryTime?.toISOString(), exitTime: session.exitTime?.toISOString(), dwellMinutes: Math.round(mins), limitMinutes: CONFIG.maxDwellMinutes, excessMinutes: Math.max(0, Math.round(mins - CONFIG.maxDwellMinutes)), timestamp: new Date().toISOString() };
  const msg = type === 'violation'
    ? `🚨 ${session.plate} exceeded limit by ${payload.excessMinutes}min (on site ${payload.dwellMinutes}min)`
    : `⚠️ ${session.plate} approaching limit — ${payload.dwellMinutes}min of ${CONFIG.maxDwellMinutes}min`;
  stmts.insertAlert.run({ type, plate: session.plate, message: msg });
  push('alert', payload);
  if (CONFIG.notifications.webhookUrl) {
    try { await fetch(CONFIG.notifications.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch (e) { console.error('[NOTIFY]', e.message); }
  }
}

// ── Alta API proxy ─────────────────────────────────────────────────────────────
// All Alta calls are made server-side — credentials never exposed to browser.

app.post('/alta/login', async (req, res) => {
  const { baseUrl, username, password } = req.body;
  if (!baseUrl || !username || !password) return res.status(400).json({ ok: false, error: 'baseUrl, username and password required' });

  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/dologin`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      redirect: 'manual',
    });

    if (r.status !== 200 && r.status !== 302) {
      return res.status(401).json({ ok: false, error: `Alta returned ${r.status}` });
    }

    // Alta returns a Set-Cookie header; capture it for subsequent requests
    const cookie = r.headers.get('set-cookie');
    altaSession = { baseUrl: baseUrl.replace(/\/$/, ''), cookie, username, loggedIn: true };

    console.log(`[ALTA] Logged in as ${username} @ ${altaSession.baseUrl}`);
    push('alta_status', { loggedIn: true, baseUrl: altaSession.baseUrl, username });
    res.json({ ok: true, username, baseUrl: altaSession.baseUrl });
  } catch (e) {
    console.error('[ALTA] Login error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/alta/logout', (_req, res) => {
  altaSession = { baseUrl: null, cookie: null, username: null, loggedIn: false };
  push('alta_status', { loggedIn: false });
  res.json({ ok: true });
});

// Proxy a GET to the Alta API, requires active session
async function altaGet(path) {
  if (!altaSession.loggedIn) throw new Error('Not logged in to Alta');
  const url = `${altaSession.baseUrl}/api/v1${path}`;
  const r = await fetch(url, { headers: { Cookie: altaSession.cookie || '' } });
  if (r.status === 401) { altaSession.loggedIn = false; throw new Error('Alta session expired — please log in again'); }
  if (!r.ok) throw new Error(`Alta API error: ${r.status}`);
  return r.json();
}

// Discover cameras/devices from Alta
app.get('/alta/cameras', async (_req, res) => {
  try {
    // Alta exposes cameras under /api/v1/devices — filter by type where possible
    const data = await altaGet('/devices');
    // Normalise: Alta returns an array, each device has id, name, type, location etc.
    const devices = Array.isArray(data) ? data : (data.devices || data.items || []);
    const cameras = devices
      .filter(d => {
        const t = (d.type || d.device_type || '').toLowerCase();
        return !t || t.includes('camera') || t.includes('lpr') || t.includes('video');
      })
      .map(d => ({
        id:       d.id   || d.guid || d.device_id,
        name:     d.name || d.label || d.device_name || d.id,
        type:     d.type || d.device_type || 'camera',
        location: d.location || d.site || d.zone || '',
        online:   d.online ?? d.connected ?? true,
      }));
    res.json({ ok: true, cameras });
  } catch (e) {
    console.error('[ALTA] Camera fetch error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Discover sites from Alta (useful for filtering cameras by site)
app.get('/alta/sites', async (_req, res) => {
  try {
    const data = await altaGet('/sites');
    const sites = Array.isArray(data) ? data : (data.sites || data.items || []);
    res.json({ ok: true, sites: sites.map(s => ({ id: s.id || s.guid, name: s.name || s.id })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Camera config REST ────────────────────────────────────────────────────────
app.get('/cameras', (_req, res) => res.json(CONFIG.cameras));

app.put('/cameras/:id', (req, res) => {
  const id = req.params.id;
  const { role, label, site } = req.body;
  if (!role || !label) return res.status(400).json({ error: 'role and label required' });
  CONFIG.cameras[id] = { role, label, site: site || '' };
  stmts.upsertCamera.run({ camera_id: id, role, label, site: site || '' });
  push('cameras_update', CONFIG.cameras);
  res.json({ ok: true });
});

app.delete('/cameras/:id', (req, res) => {
  const id = req.params.id;
  delete CONFIG.cameras[id];
  stmts.deleteCamera.run(id);
  push('cameras_update', CONFIG.cameras);
  res.json({ ok: true });
});

// ── Session REST ──────────────────────────────────────────────────────────────
app.get('/sessions',           (_req, res) => res.json(stmts.getAllSessions.all().map(r => sessionForWire(rowToSession(r)))));
app.get('/sessions/active',    (_req, res) => res.json(stmts.getAllActive.all().map(r => sessionForWire(rowToSession(r)))));
app.get('/sessions/violations',(_req, res) => res.json(stmts.getViolations.all().map(r => sessionForWire(rowToSession(r)))));
app.get('/alerts',             (_req, res) => res.json(stmts.getRecentAlerts.all()));

app.delete('/sessions/:plate', (req, res) => {
  const plate = req.params.plate.toUpperCase();
  const session = activeCache.get(plate);
  if (!session) return res.status(404).json({ error: 'No active session' });
  const now = new Date();
  stmts.closeSession.run({ plate, exit_time: now.toISOString(), exit_camera: 'manual' });
  session.status = 'complete'; session.exitTime = now;
  activeCache.delete(plate);
  push('session_update', sessionForWire(session));
  res.json({ ok: true });
});

// ── Reports ───────────────────────────────────────────────────────────────────
app.get('/reports', (req, res) => {
  const range = req.query.range || '30 days';
  const offset = `-${range}`;
  res.json({
    byDay:      stmts.reportByDay.all({ offset }),
    topPlates:  stmts.reportTopPlates.all({ offset }),
    violations: stmts.reportViolations.all({ offset }),
  });
});

// ── Config ────────────────────────────────────────────────────────────────────
app.patch('/config', (req, res) => {
  if (req.body.maxDwellMinutes) CONFIG.maxDwellMinutes = parseInt(req.body.maxDwellMinutes);
  if (req.body.warnAtPercent)   CONFIG.warnAtPercent   = parseFloat(req.body.warnAtPercent);
  push('config_update', { maxDwellMinutes: CONFIG.maxDwellMinutes, warnAtPercent: CONFIG.warnAtPercent });
  res.json({ ok: true });
});

app.post('/simulate', (req, res) => res.json(processLPREvent(req.body)));

app.get('/health', (_req, res) => res.json({ ok: true, clients: sseClients.size, activeSessions: activeCache.size, dbPath: CONFIG.dbPath, altaLoggedIn: altaSession.loggedIn }));

// ── Helpers ───────────────────────────────────────────────────────────────────
function dwellMinutes(s) {
  if (!s.entryTime) return 0;
  const start = s.entryTime instanceof Date ? s.entryTime : new Date(s.entryTime);
  const end   = s.exitTime ? (s.exitTime instanceof Date ? s.exitTime : new Date(s.exitTime)) : new Date();
  return (end - start) / 60000;
}
function fmtDuration(mins) {
  const m = Math.abs(Math.round(mins));
  return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT',  () => { db.close(); console.log('\n[DB] Closed.'); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });

// ── Boot ──────────────────────────────────────────────────────────────────────
loadCamerasFromDB();
loadActiveIntoCache();

const PORT = process.env.PORT || CONFIG.port;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚗  LPR Dwell Tracker`);
  console.log(`    Dashboard:  http://localhost:${CONFIG.port}`);
  console.log(`    Webhook:    POST http://localhost:${CONFIG.port}/webhook/lpr`);
  console.log(`    Database:   ${CONFIG.dbPath}`);
  console.log(`    Cameras:    ${Object.keys(CONFIG.cameras).length} configured`);
  console.log(`    Active:     ${activeCache.size} session(s) resumed\n`);
});
