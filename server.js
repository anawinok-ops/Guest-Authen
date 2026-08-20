// server.js  –  Mahajak Guest WiFi Captive Portal
require('dotenv').config();

const express      = require('express');
const session      = require('express-session');
const helmet       = require('helmet');
const morgan       = require('morgan');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const path         = require('path');

// ─── Init DB (runs migrations + seed) ────────────────────────────────────────
require('./db/database');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Security middleware ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false  // allow inline scripts for portal page
}));

app.use(cors({
  origin: false  // same-origin only
}));

// ─── Logging ──────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('[:date[clf]] :method :url :status :res[content-length] - :response-time ms'));
}

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Session ──────────────────────────────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'change_this_secret',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   false,    // set true if using HTTPS
    httpOnly: true,
    maxAge:   8 * 60 * 60 * 1000  // 8 hours
  }
}));

// ─── Rate limiting ─────────────────────────────────────────────────────────────
const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max:      10,               // max 10 registrations per IP per window
  message:  { success: false, errors: ['ลองใหม่ในอีกสักครู่'] }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  message:  { success: false, message: 'ลองใหม่ในอีกสักครู่' }
});

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Routes ──────────────────────────────────────────────────────────────────
const portalRoutes = require('./routes/portal');
const adminRoutes  = require('./routes/admin');

app.use('/register', registrationLimiter);   // rate-limit registration endpoint
app.use('/admin/login', loginLimiter);       // rate-limit login endpoint

app.use('/',      portalRoutes);
app.use('/admin', adminRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Background job: expire old sessions every 5 minutes ─────────────────────
const db = require('./db/database');
setInterval(() => {
  const result = db.prepare(`
    UPDATE sessions
    SET    status = 'expired', ended_at = datetime('now','localtime')
    WHERE  status = 'active' AND datetime(expires_at) <= datetime('now','localtime')
  `).run();
  if (result.changes > 0) {
    console.log(`[CLEANUP] Expired ${result.changes} session(s)`);
  }
}, 5 * 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n┌─────────────────────────────────────────────┐`);
  console.log(`│   Mahajak Guest WiFi Portal                 │`);
  console.log(`│   http://0.0.0.0:${PORT}                       │`);
  console.log(`│   Admin: http://0.0.0.0:${PORT}/admin           │`);
  console.log(`└─────────────────────────────────────────────┘\n`);
});

module.exports = app;
