// db/database.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './db/portal.db';

// Ensure db directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Initialize Tables ───────────────────────────────────────────────────────

db.exec(`
  -- Guest registrations
  CREATE TABLE IF NOT EXISTS registrations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    firstname   TEXT    NOT NULL,
    lastname    TEXT    NOT NULL,
    phone       TEXT    NOT NULL,
    mac_address TEXT,
    ip_address  TEXT,
    user_agent  TEXT,
    consent     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    session_end TEXT
  );

  -- WiFi sessions (tracks active/expired)
  CREATE TABLE IF NOT EXISTS sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_id INTEGER NOT NULL,
    mac_address     TEXT,
    ip_address      TEXT    NOT NULL,
    started_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    expires_at      TEXT    NOT NULL,
    ended_at        TEXT,
    status          TEXT    NOT NULL DEFAULT 'active',  -- active | expired | terminated
    FOREIGN KEY (registration_id) REFERENCES registrations(id)
  );

  -- Admin accounts
  CREATE TABLE IF NOT EXISTS admins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE,
    password   TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    last_login TEXT
  );

  -- Indexes for performance
  CREATE INDEX IF NOT EXISTS idx_reg_created   ON registrations(created_at);
  CREATE INDEX IF NOT EXISTS idx_reg_phone     ON registrations(phone);
  CREATE INDEX IF NOT EXISTS idx_reg_mac       ON registrations(mac_address);
  CREATE INDEX IF NOT EXISTS idx_ses_status    ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_ses_ip        ON sessions(ip_address);
  CREATE INDEX IF NOT EXISTS idx_ses_expires   ON sessions(expires_at);
`);

// ─── Seed default admin if none exists ───────────────────────────────────────
const bcrypt = require('bcryptjs');

const adminCount = db.prepare('SELECT COUNT(*) as cnt FROM admins').get();
if (adminCount.cnt === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'Mahajak@2024';
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run(username, hash);
  console.log(`[DB] Default admin created: ${username}`);
}

console.log('[DB] Database initialized:', DB_PATH);

module.exports = db;
