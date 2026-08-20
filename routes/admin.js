// routes/admin.js
const express      = require('express');
const router       = express.Router();
const bcrypt       = require('bcryptjs');
const db           = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const ExcelJS      = require('exceljs');

// ─── Auth ─────────────────────────────────────────────────────────────────────

// GET /admin/login
router.get('/login', (req, res) => {
  if (req.session?.adminId) return res.redirect('/admin');
  res.sendFile('admin-login.html', { root: './public' });
});

// POST /admin/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูล' });
  }

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(401).json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }

  req.session.adminId   = admin.id;
  req.session.adminName = admin.username;

  // Update last login
  db.prepare("UPDATE admins SET last_login = datetime('now','localtime') WHERE id = ?").run(admin.id);

  return res.json({ success: true, redirect: '/admin' });
});

// POST /admin/logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ─── Dashboard (protected) ────────────────────────────────────────────────────

// GET /admin  → serve admin dashboard HTML
router.get('/', requireAdmin, (req, res) => {
  res.sendFile('admin.html', { root: './public' });
});

// GET /admin/api/stats  → summary stats
router.get('/api/stats', requireAdmin, (req, res) => {
  const today = db.prepare(`
    SELECT COUNT(*) as cnt FROM registrations
    WHERE date(created_at) = date('now','localtime')
  `).get();

  const thisMonth = db.prepare(`
    SELECT COUNT(*) as cnt FROM registrations
    WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now','localtime')
  `).get();

  const thisYear = db.prepare(`
    SELECT COUNT(*) as cnt FROM registrations
    WHERE strftime('%Y', created_at) = strftime('%Y', 'now','localtime')
  `).get();

  const total = db.prepare('SELECT COUNT(*) as cnt FROM registrations').get();

  const activeSessions = db.prepare(`
    SELECT COUNT(*) as cnt FROM sessions
    WHERE status = 'active' AND datetime(expires_at) > datetime('now','localtime')
  `).get();

  return res.json({
    today:          today.cnt,
    thisMonth:      thisMonth.cnt,
    thisYear:       thisYear.cnt,
    total:          total.cnt,
    activeSessions: activeSessions.cnt
  });
});

// GET /admin/api/registrations  → paginated list with filters
router.get('/api/registrations', requireAdmin, (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(100, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const search = req.query.search ? `%${req.query.search}%` : null;
  const dateFrom = req.query.dateFrom || null;
  const dateTo   = req.query.dateTo   || null;

  let where  = [];
  let params = [];

  if (search) {
    where.push('(firstname LIKE ? OR lastname LIKE ? OR phone LIKE ?)');
    params.push(search, search, search);
  }
  if (dateFrom) {
    where.push('date(created_at) >= date(?)');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('date(created_at) <= date(?)');
    params.push(dateTo);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM registrations ${whereClause}`).get(...params);
  const rows  = db.prepare(`
    SELECT id, firstname, lastname, phone, ip_address, mac_address, created_at, session_end
    FROM   registrations
    ${whereClause}
    ORDER  BY created_at DESC
    LIMIT  ? OFFSET ?
  `).all(...params, limit, offset);

  return res.json({
    data:       rows,
    total:      total.cnt,
    page,
    limit,
    totalPages: Math.ceil(total.cnt / limit)
  });
});

// GET /admin/api/report/daily  → registrations per day (last 30 days)
router.get('/api/report/daily', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT date(created_at) as date, COUNT(*) as count
    FROM   registrations
    WHERE  date(created_at) >= date('now','-29 days','localtime')
    GROUP  BY date(created_at)
    ORDER  BY date ASC
  `).all();

  return res.json(rows);
});

// GET /admin/api/report/monthly  → registrations per month (last 12 months)
router.get('/api/report/monthly', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
    FROM   registrations
    WHERE  created_at >= date('now','-11 months','start of month','localtime')
    GROUP  BY month
    ORDER  BY month ASC
  `).all();

  return res.json(rows);
});

// GET /admin/api/report/yearly  → registrations per year
router.get('/api/report/yearly', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT strftime('%Y', created_at) as year, COUNT(*) as count
    FROM   registrations
    GROUP  BY year
    ORDER  BY year ASC
  `).all();

  return res.json(rows);
});

// ─── Sessions management ──────────────────────────────────────────────────────

// GET /admin/api/sessions  → active sessions list
router.get('/api/sessions', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.ip_address, s.mac_address, s.started_at, s.expires_at, s.status,
           r.firstname, r.lastname, r.phone
    FROM   sessions s
    JOIN   registrations r ON r.id = s.registration_id
    WHERE  s.status = 'active'
    ORDER  BY s.started_at DESC
    LIMIT  200
  `).all();

  return res.json(rows);
});

// DELETE /admin/api/sessions/:id  → terminate session
router.delete('/api/sessions/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare(`
    UPDATE sessions SET status = 'terminated', ended_at = datetime('now','localtime')
    WHERE id = ?
  `).run(id);
  return res.json({ success: true });
});

// POST /admin/api/sessions/cleanup  → expire all timed-out sessions
router.post('/api/sessions/cleanup', requireAdmin, (req, res) => {
  const result = db.prepare(`
    UPDATE sessions
    SET    status = 'expired', ended_at = datetime('now','localtime')
    WHERE  status = 'active' AND datetime(expires_at) <= datetime('now','localtime')
  `).run();
  return res.json({ success: true, expired: result.changes });
});

// ─── Export ───────────────────────────────────────────────────────────────────

// GET /admin/api/export/excel?dateFrom=&dateTo=
router.get('/api/export/excel', requireAdmin, async (req, res) => {
  const dateFrom = req.query.dateFrom || null;
  const dateTo   = req.query.dateTo   || null;

  let where  = [];
  let params = [];

  if (dateFrom) { where.push('date(created_at) >= date(?)'); params.push(dateFrom); }
  if (dateTo)   { where.push('date(created_at) <= date(?)'); params.push(dateTo); }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT id, firstname, lastname, phone, ip_address, mac_address, created_at, session_end
    FROM   registrations
    ${whereClause}
    ORDER  BY created_at DESC
  `).all(...params);

  const workbook  = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Guest Registrations');

  // Header styling
  worksheet.columns = [
    { header: 'ลำดับ',           key: 'id',          width: 8  },
    { header: 'ชื่อ',            key: 'firstname',   width: 18 },
    { header: 'นามสกุล',         key: 'lastname',    width: 18 },
    { header: 'เบอร์โทรศัพท์',   key: 'phone',       width: 16 },
    { header: 'IP Address',      key: 'ip_address',  width: 16 },
    { header: 'MAC Address',     key: 'mac_address', width: 20 },
    { header: 'วันที่ลงทะเบียน', key: 'created_at',  width: 22 },
    { header: 'สิ้นสุด Session',  key: 'session_end', width: 22 },
  ];

  // Style header row
  worksheet.getRow(1).eachCell(cell => {
    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } };
    cell.font   = { bold: true, color: { argb: 'FFD4AF37' }, size: 11 };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FFD4AF37' } } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  worksheet.getRow(1).height = 28;

  // Data rows
  rows.forEach((row, i) => {
    const dataRow = worksheet.addRow(row);
    if (i % 2 === 1) {
      dataRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F0' } };
      });
    }
  });

  // Title row above header
  worksheet.spliceRows(1, 0, [`รายงานการลงทะเบียน Guest WiFi - Mahajak Development Co., Ltd.`]);
  worksheet.getRow(1).font = { bold: true, size: 13, color: { argb: 'FF1B2A4A' } };
  worksheet.mergeCells('A1:H1');
  worksheet.getRow(1).height = 30;

  const filename = `guest-wifi-${dateFrom || 'all'}-${dateTo || 'all'}.xlsx`;
  res.setHeader('Content-Type',        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

// GET /admin/api/export/csv
router.get('/api/export/csv', requireAdmin, (req, res) => {
  const dateFrom = req.query.dateFrom || null;
  const dateTo   = req.query.dateTo   || null;

  let where  = [];
  let params = [];
  if (dateFrom) { where.push('date(created_at) >= date(?)'); params.push(dateFrom); }
  if (dateTo)   { where.push('date(created_at) <= date(?)'); params.push(dateTo); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT id, firstname, lastname, phone, ip_address, mac_address, created_at, session_end
    FROM   registrations ${whereClause} ORDER BY created_at DESC
  `).all(...params);

  const headers = 'ลำดับ,ชื่อ,นามสกุล,เบอร์โทรศัพท์,IP Address,MAC Address,วันที่ลงทะเบียน,สิ้นสุด Session\n';
  const csvRows = rows.map(r =>
    [r.id, r.firstname, r.lastname, r.phone, r.ip_address || '', r.mac_address || '', r.created_at, r.session_end || '']
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  ).join('\n');

  const bom = '\uFEFF'; // UTF-8 BOM for Excel Thai charset
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="guest-wifi.csv"`);
  res.send(bom + headers + csvRows);
});

// ─── Admin password change ────────────────────────────────────────────────────
router.post('/api/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);

  if (!bcrypt.compareSync(currentPassword, admin.password)) {
    return res.status(400).json({ success: false, message: 'รหัสผ่านเดิมไม่ถูกต้อง' });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ success: false, message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร' });
  }

  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE admins SET password = ? WHERE id = ?').run(hash, admin.id);
  return res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
});

module.exports = router;
