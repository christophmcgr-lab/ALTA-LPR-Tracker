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
// Serve static files — disable caching for HTML so browsers always get the latest version
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      // JS/CSS/images can be cached for 1 hour
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

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

// Migrate existing DB — add snapshot_url column if not present (safe to run every boot)
try { db.exec('ALTER TABLE sessions ADD COLUMN snapshot_url TEXT'); } catch(_) { /* column already exists */ }

// ── Prepared statements ───────────────────────────────────────────────────────
const stmts = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (plate, entry_time, exit_time, entry_camera, exit_camera,
      status, alerted_warning, alerted_violation, snapshot_url, updated_at)
    VALUES (@plate, @entry_time, @exit_time, @entry_camera, @exit_camera,
      @status, @alerted_warning, @alerted_violation, @snapshot_url, datetime('now'))
    ON CONFLICT(plate, entry_time) DO UPDATE SET
      exit_time=excluded.exit_time, exit_camera=excluded.exit_camera,
      status=excluded.status, alerted_warning=excluded.alerted_warning,
      alerted_violation=excluded.alerted_violation,
      snapshot_url=COALESCE(excluded.snapshot_url, sessions.snapshot_url),
      updated_at=datetime('now')
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
    snapshotUrl:      row.snapshot_url || null,
  };
}
function sessionToRow(s) {
  return {
    plate: s.plate,
    // Store as ISO string with UTC offset so the original local time is preserved
    entry_time:  s.entryTime  ? toLocalISO(s.entryTime, s._entryTzOffset)  : null,
    exit_time:   s.exitTime   ? toLocalISO(s.exitTime,  s._exitTzOffset)   : null,
    entry_camera: s.entryCamera || null,
    exit_camera:  s.exitCamera  || null,
    status: s.status,
    alerted_warning:   s.alertedWarning   ? 1 : 0,
    alerted_violation: s.alertedViolation ? 1 : 0,
    snapshot_url: s.snapshotUrl || null,
  };
}

// Serialise a Date to ISO string using the original timezone offset (minutes).
// Falls back to the Date's UTC value if no offset supplied.
// e.g. toLocalISO(d, 660) → "2026-03-26T09:10:33+11:00"
function toLocalISO(date, tzOffsetMinutes) {
  if (tzOffsetMinutes == null) return date.toISOString();
  const sign   = tzOffsetMinutes >= 0 ? '+' : '-';
  const abs    = Math.abs(tzOffsetMinutes);
  const hh     = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm     = String(abs % 60).padStart(2, '0');
  // Shift the date by the offset to get local time digits
  const local  = new Date(date.getTime() + tzOffsetMinutes * 60000);
  return local.toISOString().replace('Z', `${sign}${hh}:${mm}`);
}
function sessionForWire(s) {
  return {
    ...s,
    // Send the original Alta time string to the browser so it displays in the local timezone
    // Fall back to toLocalISO if no raw string available (e.g. for simulated events)
    entryTime:    s._entryRawTime || (s.entryTime ? toLocalISO(s.entryTime, s._entryTzOffset) : null),
    exitTime:     s._exitRawTime  || (s.exitTime  ? toLocalISO(s.exitTime,  s._exitTzOffset)  : null),
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
// Debug endpoint — see the last 20 raw payloads received
const rawWebhookLog = [];
app.get('/webhook/debug', (_req, res) => res.json(rawWebhookLog));

app.post('/webhook/lpr', (req, res) => {
  const raw = JSON.stringify(req.body);

  // Always log and store raw payload for debugging
  console.log('[WEBHOOK] Received:', raw.slice(0, 500));
  rawWebhookLog.unshift({ ts: new Date().toISOString(), body: req.body });
  if (rawWebhookLog.length > 20) rawWebhookLog.pop();

  // Push raw event to dashboard so it's visible immediately even if camera not matched
  push('webhook_raw', { ts: new Date().toISOString(), body: req.body });

  const event = normaliseAltaPayload(req.body);
  if (!event) {
    console.warn('[WEBHOOK] Unrecognised payload shape:', raw.slice(0, 200));
    return res.status(400).json({ error: 'Unrecognised payload shape', received: req.body });
  }
  // Placeholder/test event — acknowledge but don't process
  if (event._skip) {
    return res.json({ ok: true, skipped: true, reason: 'Placeholder test event (N/A values)' });
  }

  console.log(`[WEBHOOK] Normalised → plate:${event.plate} camera_id:${event.camera_id} ts:${event.timestamp}`);
  const result = processLPREvent(event, raw);
  console.log('[WEBHOOK] Result:', JSON.stringify(result));
  res.json(result);
});

// Parse Alta's human-readable timestamp formats into a { date, tzOffsetMinutes } object.
// Alta sends formats like:
//   "Thursday, March 26, 2026 09:10:33 AEDT"   → +11:00 = +660 min
//   "Thursday, March 26, 2026 06:11:42 +08"     → +08:00 = +480 min
//   "2026-03-26T09:10:33+11:00"                  → ISO with offset
//   "N/A"
const TZ_MAP = {
  'AEDT': 660,  'AEST': 600,  'AWST': 480,
  'SGT':  480,  'MYT':  480,  'WIB':  420,
  'JST':  540,  'KST':  540,  'IST':  330,
  'GMT':  0,    'UTC':  0,    'BST':  60,
  'CET':  60,   'CEST': 120,  'EET':  120,
  'EST':  -300, 'EDT':  -240, 'CST':  -360,
  'CDT':  -300, 'MST':  -420, 'MDT':  -360,
  'PST':  -480, 'PDT':  -420,
};

function parseAltaTime(raw) {
  if (!raw || raw === 'N/A' || raw.trim() === '') return { date: new Date(), tzOffsetMinutes: null };

  // ISO string with numeric offset e.g. "2026-03-26T09:10:33+11:00"
  const isoOffsetMatch = raw.match(/([+-])(\d{2}):?(\d{2})$/);
  const iso = new Date(raw);
  if (!isNaN(iso) && isoOffsetMatch) {
    const sign = isoOffsetMatch[1] === '+' ? 1 : -1;
    const tzOffsetMinutes = sign * (parseInt(isoOffsetMatch[2]) * 60 + parseInt(isoOffsetMatch[3]));
    return { date: iso, tzOffsetMinutes };
  }
  if (!isNaN(iso)) return { date: iso, tzOffsetMinutes: null };

  // Strip weekday prefix: "Thursday, March 26, 2026 09:10:33 AEDT" → "March 26, 2026 09:10:33 AEDT"
  const stripped = raw.replace(/^[A-Za-z]+,\s*/, '');

  // Check for named TZ abbreviation at end
  const namedTzMatch = stripped.match(/\s+([A-Z]{2,5})$/);
  let tzOffsetMinutes = null;
  let normalised = stripped;

  if (namedTzMatch && TZ_MAP[namedTzMatch[1]] !== undefined) {
    tzOffsetMinutes = TZ_MAP[namedTzMatch[1]];
    const offsetStr = (tzOffsetMinutes >= 0 ? '+' : '-') +
      String(Math.floor(Math.abs(tzOffsetMinutes) / 60)).padStart(2, '0') + ':' +
      String(Math.abs(tzOffsetMinutes) % 60).padStart(2, '0');
    normalised = stripped.replace(/\s+[A-Z]{2,5}$/, offsetStr);
  } else {
    // Numeric offset e.g. "+08" or "+08:00" at end
    const numTzMatch = stripped.match(/\s+([+-]\d{2}:?\d{0,2})$/);
    if (numTzMatch) {
      const parts = numTzMatch[1].replace(':', '').match(/([+-])(\d{2})(\d{0,2})/);
      if (parts) {
        const sign = parts[1] === '+' ? 1 : -1;
        tzOffsetMinutes = sign * (parseInt(parts[2]) * 60 + (parseInt(parts[3] || '0')));
      }
    }
  }

  const d = new Date(normalised);
  if (!isNaN(d)) return { date: d, tzOffsetMinutes };

  // Last resort: strip timezone entirely
  const noTz = stripped.replace(/\s+[A-Z]{2,5}$/, '').replace(/\s+[+-]\d{2}:?\d{0,2}$/, '');
  const d2 = new Date(noTz);
  if (!isNaN(d2)) { console.warn(`[TIME] Stripped tz from: "${raw}"`); return { date: d2, tzOffsetMinutes: null }; }

  console.warn(`[TIME] Could not parse: "${raw}" — using now`);
  return { date: new Date(), tzOffsetMinutes: null };
}

// Returns true for Alta placeholder "N/A" values
function isNA(v) { return !v || String(v).trim().toUpperCase() === 'N/A'; }

function normaliseAltaPayload(body) {
  // Shape 1: Alta rule/webhook format
  // { eventType, time, camera: { name, site }, lpr: { plate, confidence }, snapshotUrl }
  if (body.lpr && body.lpr.plate) {
    // Reject test/placeholder events where Alta hasn't substituted real values yet
    if (isNA(body.lpr.plate)) {
      console.log('[WEBHOOK] Skipping placeholder/test event (plate is N/A)');
      return { _skip: true };
    }
    const camName = isNA(body.camera?.name) ? null : body.camera?.name;
    const camSite = isNA(body.camera?.site) ? null : body.camera?.site;
    const parsedTime = parseAltaTime(body.time);
    return {
      plate:      body.lpr.plate,
      camera_id:  camName || camSite || 'unknown',
      timestamp:  parsedTime.date,
      rawTime:    isNA(body.time) ? null : body.time,
      tzOffset:   parsedTime.tzOffsetMinutes,
      confidence: isNA(body.lpr.confidence) ? 1 : (parseFloat(body.lpr.confidence) || 1),
      meta: {
        eventType:    body.eventType,
        cameraName:   camName,
        site:         camSite,
        vehicleColor: isNA(body.lpr.vehicleColor) ? null : body.lpr.vehicleColor,
        vehicleType:  isNA(body.lpr.vehicleType)  ? null : body.lpr.vehicleType,
        snapshotUrl:  isNA(body.snapshotUrl)       ? null : body.snapshotUrl,
      },
    };
  }
  // Shape 2: { event: 'lpr.read', plate, camera_id, timestamp }
  if (body.event === 'lpr.read' || body.event === 'lpr_read') {
    const p2 = parseAltaTime(body.timestamp);
    return { plate: body.plate, camera_id: body.camera_id, timestamp: p2.date, tzOffset: p2.tzOffsetMinutes, confidence: body.confidence };
  }
  // Shape 3: { type: 'LPR', data: { plate_number, device_id } }
  if (body.type === 'LPR' && body.data) {
    const p3 = parseAltaTime(body.data.occurred_at);
    return { plate: body.data.plate_number, camera_id: body.data.device_id, timestamp: p3.date, tzOffset: p3.tzOffsetMinutes };
  }
  // Shape 4: flat { plate, camera_id }
  if (body.plate_number || body.plate) {
    const p4 = parseAltaTime(body.timestamp);
    return { plate: body.plate_number || body.plate, camera_id: body.camera_id || body.device_id, timestamp: p4.date, tzOffset: p4.tzOffsetMinutes };
  }
  return null;
}

// ── Core LPR processor ────────────────────────────────────────────────────────
function processLPREvent({ plate, camera_id, timestamp, rawTime = null, tzOffset = null, confidence = 1, meta = {} }, rawJson = null) {
  plate = (plate || '').toUpperCase().trim();
  if (!plate) return { ok: false, error: 'Missing plate' };
  // Match by exact ID first, then fall back to matching by label name (for Alta rule webhooks
  // which send camera.name rather than a GUID)
  const cam = CONFIG.cameras[camera_id]
    || Object.values(CONFIG.cameras).find(c => c.label?.toLowerCase() === camera_id?.toLowerCase())
    || null;
  if (!cam) {
    console.warn(`[LPR] Unknown camera: ${camera_id} — register it in Settings first`);
    return { ok: false, error: `Unknown camera: ${camera_id}` };
  }
  // Resolve the canonical camera_id key for DB storage
  const resolvedCameraId = CONFIG.cameras[camera_id]
    ? camera_id
    : Object.keys(CONFIG.cameras).find(k => CONFIG.cameras[k].label?.toLowerCase() === camera_id?.toLowerCase()) || camera_id;

  const ts = (timestamp instanceof Date && !isNaN(timestamp)) ? timestamp : (timestamp ? new Date(timestamp) : new Date());
  stmts.insertEvent.run({ plate, camera_id: resolvedCameraId, role: cam.role, confidence, ts: ts.toISOString(), raw: rawJson });

  // ── Determine effective role for this read ───────────────────────────────────
  // 'both' cameras toggle: first read = entry, second read = exit.
  // Debounce: ignore a second read on a 'both' camera within 5 seconds of the
  // first — this prevents duplicate LPR fires from the same pass-through
  // being treated as an immediate entry+exit pair.
  let effectiveRole = cam.role;
  if (cam.role === 'both') {
    const existing = activeCache.get(plate);
    if (existing) {
      const secondsSinceEntry = existing.entryTime ? (ts - existing.entryTime) / 1000 : Infinity;
      if (secondsSinceEntry < 5) {
        console.log(`[LPR] ${plate} debounced on ${cam.label} — only ${secondsSinceEntry.toFixed(1)}s since entry, ignoring`);
        return { ok: true, plate, role: 'debounced', skipped: true };
      }
      effectiveRole = 'exit';
    } else {
      effectiveRole = 'entry';
    }
    console.log(`[LPR] ${plate} on both-direction camera ${cam.label} → treating as ${effectiveRole}`);
  }

  if (effectiveRole === 'entry') {
    const existing = activeCache.get(plate);
    if (existing) {
      // Already on site from a different entry — log duplicate, don't reset timer
      console.log(`[LPR] ${plate} re-read at entry (already on site since ${existing.entryTime})`);
      push('lpr_read', { plate, role: 'entry', camera: cam.label, duplicate: true, ts: ts.toISOString() });
    } else {
      const session = { plate, entryTime: ts, exitTime: null, entryCamera: resolvedCameraId, exitCamera: null, status: 'active', alertedWarning: false, alertedViolation: false, _entryTzOffset: tzOffset, _exitTzOffset: null, _entryRawTime: rawTime, _exitRawTime: null, snapshotUrl: meta.snapshotUrl || null };
      stmts.upsertSession.run(sessionToRow(session));
      activeCache.set(plate, session);
      console.log(`[LPR] ✅ ${plate} ENTERED via ${cam.label}`);
      push('session_update', sessionForWire(session));
    }
  } else if (effectiveRole === 'exit') {
    const session = activeCache.get(plate);
    if (session) {
      session.exitTime = ts; session.exitCamera = resolvedCameraId; session.status = 'complete'; session._exitTzOffset = tzOffset; session._exitRawTime = rawTime; if (meta.snapshotUrl) session.snapshotUrl = meta.snapshotUrl;
      stmts.upsertSession.run(sessionToRow(session));
      activeCache.delete(plate);
      const mins = dwellMinutes(session);
      const over = mins > CONFIG.maxDwellMinutes;
      console.log(`[LPR] 🚗 ${plate} EXITED via ${cam.label} — ${fmtDuration(mins)} ${over ? '⚠️ EXCEEDED' : '✅'}`);
      push('session_update', sessionForWire(session));
      if (over) notify('violation', session);
    } else {
      // Exit read with no matching entry — record it but mark entry as unknown
      const session = { plate, entryTime: null, exitTime: ts, entryCamera: null, exitCamera: resolvedCameraId, status: 'complete', alertedWarning: false, alertedViolation: false, _entryTzOffset: null, _exitTzOffset: tzOffset, _entryRawTime: null, _exitRawTime: rawTime, snapshotUrl: meta.snapshotUrl || null };
      stmts.upsertSession.run(sessionToRow(session));
      console.log(`[LPR] ${plate} exited via ${cam.label} (no matching entry)`);
      push('session_update', sessionForWire(session));
    }
  }
  return { ok: true, plate, role: effectiveRole };
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

  const base = baseUrl.replace(/\/$/, '');
  const url = `${base}/api/v1/dologin`;
  console.log(`[ALTA] Login attempt → ${url}`);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      redirect: 'manual',
    });

    console.log(`[ALTA] dologin status: ${r.status}`);

    // Alta returns 200 or 302 on success
    if (r.status !== 200 && r.status !== 302) {
      let body = '';
      try { body = await r.text(); } catch(_) {}
      console.error(`[ALTA] Login failed: ${r.status} — ${body.slice(0, 200)}`);
      return res.status(401).json({ ok: false, error: `Alta returned HTTP ${r.status}. Check your deployment URL and credentials.` });
    }

    // Capture ALL Set-Cookie headers — Alta may set multiple cookies
    // Node fetch collapses them with commas; we need the raw values
    const rawCookie = r.headers.get('set-cookie') || '';
    console.log(`[ALTA] Raw Set-Cookie: ${rawCookie.slice(0, 200)}`);

    // Extract just the name=value pairs (strip attributes like Path, HttpOnly, etc.)
    const cookieHeader = rawCookie
      .split(/,(?=[^ ]+?=)/)           // split multiple cookies on comma NOT inside a value
      .map(c => c.split(';')[0].trim()) // keep only name=value part
      .join('; ');

    if (!cookieHeader) {
      console.error('[ALTA] No cookie in response — login may have succeeded but no session established');
    }

    altaSession = { baseUrl: base, cookie: cookieHeader, username, loggedIn: true };
    console.log(`[ALTA] ✅ Logged in as ${username} @ ${base} | cookie: ${cookieHeader.slice(0, 60)}…`);
    push('alta_status', { loggedIn: true, baseUrl: base, username });
    res.json({ ok: true, username, baseUrl: base });
  } catch (e) {
    console.error('[ALTA] Login error:', e.message);
    res.status(500).json({ ok: false, error: `Connection failed: ${e.message}. Check the deployment URL is correct and reachable.` });
  }
});

app.post('/alta/logout', (_req, res) => {
  altaSession = { baseUrl: null, cookie: null, username: null, loggedIn: false };
  push('alta_status', { loggedIn: false });
  res.json({ ok: true });
});

// Proxy a GET to the Alta API, requires active session
async function altaGet(path) {
  if (!altaSession.loggedIn) throw new Error('Not logged in to Alta — connect in Settings first');
  const url = `${altaSession.baseUrl}/api/v1${path}`;
  console.log(`[ALTA] GET ${url}`);
  const r = await fetch(url, {
    headers: {
      'Cookie': altaSession.cookie || '',
      'Accept': 'application/json',
    },
  });
  console.log(`[ALTA] GET ${path} → ${r.status}`);
  if (r.status === 401) {
    altaSession.loggedIn = false;
    throw new Error('Alta session expired — please reconnect in Settings');
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Alta API ${path} returned ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

// Discover cameras/devices from Alta
app.get('/alta/cameras', async (_req, res) => {
  try {
    const data = await altaGet('/devices');
    console.log('[ALTA] /devices raw sample:', JSON.stringify(data).slice(0, 500));

    // Normalise response — Alta may wrap the array or return it directly
    const devices = Array.isArray(data) ? data : (data.devices || data.items || data.data || []);
    console.log(`[ALTA] Found ${devices.length} device(s) total`);

    // Show ALL devices in logs so we can see what fields/types are returned
    devices.forEach((d, i) => {
      if (i < 5) console.log(`[ALTA] device[${i}]:`, JSON.stringify(d).slice(0, 200));
    });

    // Return all devices — let the user pick which are LPR cameras
    const cameras = devices.map(d => ({
      id:       d.id   || d.guid || d.device_id || d.entityId || String(i),
      name:     d.name || d.label || d.device_name || d.displayName || d.id || 'Unknown',
      type:     d.type || d.device_type || d.deviceType || 'device',
      location: d.location || d.site || d.site_name || d.zone || d.siteName || '',
      online:   d.online ?? d.connected ?? d.isOnline ?? true,
    }));

    res.json({ ok: true, cameras, total: devices.length });
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
function shutdown() { try { db.close(); } catch(_){} console.log('\n[DB] Closed.'); process.exit(0); }
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ── Boot ──────────────────────────────────────────────────────────────────────
loadCamerasFromDB();
loadActiveIntoCache();

const PORT = parseInt(process.env.PORT || CONFIG.port, 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚗  LPR Dwell Tracker`);
  console.log(`    Listening:  0.0.0.0:${PORT}`);
  console.log(`    Database:   ${CONFIG.dbPath}`);
  console.log(`    Cameras:    ${Object.keys(CONFIG.cameras).length} configured`);
  console.log(`    Active:     ${activeCache.size} session(s) resumed\n`);
});
