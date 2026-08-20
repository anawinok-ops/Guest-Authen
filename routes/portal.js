// routes/portal.js
const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

const SESSION_MINUTES = parseInt(process.env.SESSION_DURATION_MINUTES) || 480;
const REDIRECT_URL    = process.env.REDIRECT_URL || 'https://www.mahajak.com/th/';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress ||
    ''
  );
}

function getMacFromHeaders(req) {
  // FortiGate passes MAC in header when captive portal mode is active
  return req.headers['x-mac-address'] || req.query.mac || null;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function toLocalISO(date) {
  // Store in Asia/Bangkok time (UTC+7)
  const offset = 7 * 60;
  const local  = new Date(date.getTime() + offset * 60000);
  return local.toISOString().replace('T', ' ').substring(0, 19);
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateRegistration(data) {
  const errors = [];

  const firstname = (data.firstname || '').trim();
  const lastname  = (data.lastname  || '').trim();
  const phone     = (data.phone     || '').trim().replace(/[-\s]/g, '');

  if (!firstname || firstname.length < 2 || firstname.length > 50) {
    errors.push('ชื่อต้องมี 2-50 ตัวอักษร');
  }
  if (!lastname || lastname.length < 2 || lastname.length > 50) {
    errors.push('นามสกุลต้องมี 2-50 ตัวอักษร');
  }
  if (!/^0[0-9]{8,9}$/.test(phone)) {
    errors.push('หมายเลขโทรศัพท์ไม่ถูกต้อง (ตัวอย่าง: 0812345678)');
  }
  if (!data.consent || data.consent === 'false') {
    errors.push('กรุณายินยอมนโยบายความเป็นส่วนตัว');
  }

  return { errors, firstname, lastname, phone };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /  →  Serve the captive portal HTML page
router.get('/', (req, res) => {
  const ip  = getClientIP(req);
  const mac = getMacFromHeaders(req);

  // Check if already has active session
  const existing = db.prepare(`
    SELECT s.id, s.expires_at
    FROM   sessions s
    WHERE  s.ip_address = ?
      AND  s.status = 'active'
      AND  datetime(s.expires_at) > datetime('now', 'localtime')
    ORDER  BY s.started_at DESC
    LIMIT  1
  `).get(ip);

  if (existing) {
    // Already registered → redirect directly
    return res.redirect(REDIRECT_URL);
  }

  res.sendFile('index.html', { root: './public' });
});

// POST /register  →  Register guest
router.post('/register', async (req, res) => {
  const ip  = getClientIP(req);
  const mac = getMacFromHeaders(req);
  const ua  = req.headers['user-agent'] || '';

  const { errors, firstname, lastname, phone } = validateRegistration(req.body);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  try {
    // Save registration
    const now       = new Date();
    const expiresAt = addMinutes(now, SESSION_MINUTES);

    const regResult = db.prepare(`
      INSERT INTO registrations (firstname, lastname, phone, mac_address, ip_address, user_agent, consent, session_end)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).run(firstname, lastname, phone, mac, ip, ua, toLocalISO(expiresAt));

    const registrationId = regResult.lastInsertRowid;

    // Create active session
    db.prepare(`
      INSERT INTO sessions (registration_id, mac_address, ip_address, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(registrationId, mac, ip, toLocalISO(expiresAt));

    console.log(`[PORTAL] Registered: ${firstname} ${lastname} | IP: ${ip} | Phone: ${phone}`);

    // สร้าง Guest User บน FortiGate เพื่อใช้ยิง fgtauth จาก Client
    let fgtCreds = null;
    try {
      const { createGuestUser } = require('../lib/fortigate');
      fgtCreds = await createGuestUser(phone);
    } catch (fgtErr) {
      console.error('[FortiGate] createGuestUser failed:', fgtErr.message);
      // ไม่ block user ถ้า FortiGate API ล่ม ให้ยัง redirect ปกติได้ (fail-open ทาง UX)
    }

    return res.json({
      success:     true,
      redirect:    REDIRECT_URL,
      sessionMins: SESSION_MINUTES,
      message:     'ลงทะเบียนสำเร็จ',
      fgtUsername: fgtCreds ? fgtCreds.username : null,
      fgtPassword: fgtCreds ? fgtCreds.password : null
    });

  } catch (err) {
    console.error('[PORTAL] Registration error:', err);
    return res.status(500).json({ success: false, errors: ['เกิดข้อผิดพลาด กรุณาลองใหม่'] });
  }
});

// GET /check-session  →  Check if IP has active session (used by FortiGate or self-check)
router.get('/check-session', (req, res) => {
  const ip = getClientIP(req);

  const session = db.prepare(`
    SELECT s.id, s.expires_at, r.firstname, r.lastname
    FROM   sessions s
    JOIN   registrations r ON r.id = s.registration_id
    WHERE  s.ip_address = ?
      AND  s.status = 'active'
      AND  datetime(s.expires_at) > datetime('now', 'localtime')
    ORDER  BY s.started_at DESC
    LIMIT  1
  `).get(ip);

  if (session) {
    return res.json({ active: true, expiresAt: session.expires_at, name: `${session.firstname} ${session.lastname}` });
  }

  return res.json({ active: false });
});

module.exports = router;

// ─── Helper: escape HTML เพื่อป้องกัน XSS จากชื่อผู้ใช้ ──────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// GET /register/complete  →  หน้า "สะพาน" ให้ Aruba Instant On รับ Acknowledge
router.get('/register/complete', (req, res) => {
  const name = escapeHtml(req.query.name || '');
  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>เชื่อมต่อสำเร็จ</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Sarabun',sans-serif;background:#eef2f9;display:flex;
       align-items:center;justify-content:center;min-height:100vh;padding:20px;}
  .box{background:#fff;border-radius:20px;padding:40px 32px;text-align:center;
       box-shadow:0 28px 70px rgba(15,40,120,.18);max-width:400px;width:100%;}
  h2{color:#0d1e50;margin-bottom:8px;font-size:20px;}
  p{color:#5a6a8a;font-size:14px;line-height:1.6;}
  .dot{width:8px;height:8px;border-radius:50%;background:#4ade80;
       display:inline-block;margin-right:6px;animation:blink 1.2s infinite;}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
</style>
</head>
<body>
  <div class="box">
    <h2>🎉 เชื่อมต่อสำเร็จแล้ว!</h2>
    <p>ยินดีต้อนรับคุณ <strong>${name}</strong><br>
       <span class="dot"></span>กำลังเปิดใช้งานอินเทอร์เน็ต...</p>
  </div>
  <script>
    setTimeout(function () {
      window.location.href = ${JSON.stringify(process.env.REDIRECT_URL || 'https://www.mahajak.com/th/')};
    }, 1500);
  </script>
  <div style="display:none">Aruba.InstantOn.Acknowledge</div>
</body>
</html>`);
});
