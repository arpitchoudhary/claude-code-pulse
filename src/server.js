const express = require('express');
const path = require('path');
const { parseAllSessions } = require('./parser');
const { generateOptimizations } = require('./optimizer');

function createServer() {
  const app = express();

  // Restrict access to localhost origins only
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/localhost(:\d+)?$/.test(origin) && !/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    next();
  });

  app.use(express.static(path.join(__dirname, 'public')));

  let cachedData = null;
  let lastActivity = Date.now();
  let lastHeartbeat = null; // null until first client connects

  // Track last activity time on every request
  app.use((req, res, next) => {
    lastActivity = Date.now();
    next();
  });

  app.post('/api/shutdown', (req, res) => {
    const addr = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    res.json({ ok: true });
    setImmediate(() => process.exit(0));
  });

  app.post('/api/heartbeat', (req, res) => {
    lastHeartbeat = Date.now();
    res.json({ ok: true });
  });

  app.get('/api/usage', async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === 'true';
      if (!cachedData || forceRefresh) {
        const data = await parseAllSessions(forceRefresh);
        data.optimizations = generateOptimizations(data);
        cachedData = data;
      }
      res.json(cachedData);
    } catch (err) {
      console.error('Error parsing sessions:', err.message);
      res.status(500).json({ error: 'Failed to parse session data' });
    }
  });

  // Auto-shutdown watchdog: fires every 60s
  // - Tab closed: no heartbeat for 5 min (browsers throttle background timers to ~60s)
  // - Inactivity: no API call for 1 hour
  const HEARTBEAT_TIMEOUT_MS = 4 * 60 * 1000;
  const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

  setInterval(() => {
    const now = Date.now();
    if (lastHeartbeat !== null && now - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      console.log('\n  No client for 5 minutes, shutting down...\n');
      process.exit(0);
    }
    if (now - lastActivity > INACTIVITY_TIMEOUT_MS) {
      console.log('\n  No activity for 1 hour, shutting down...\n');
      process.exit(0);
    }
  }, 60 * 1000).unref();

  return app;
}

module.exports = { createServer };
