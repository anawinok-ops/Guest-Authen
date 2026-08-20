// lib/fortigate.js — เรียก FortiGate REST API สร้าง Guest User ชั่วคราว
const https = require('https');
const crypto = require('crypto');

const FGT_HOST   = process.env.FORTIGATE_API_HOST || '172.15.0.1';
const FGT_APIKEY = process.env.FORTIGATE_API_KEY;
const FGT_GROUP  = process.env.FORTIGATE_GUEST_GROUP || 'GUEST_PORTAL_GROUP';

function fgtRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: FGT_HOST,
      port: 443,
      path,
      method,
      rejectUnauthorized: false, // FortiGate self-signed cert (internal trusted network)
      headers: {
        'Authorization': `Bearer ${FGT_APIKEY}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(chunks)); } catch { resolve({}); }
        } else {
          reject(new Error(`FortiGate API ${method} ${path} -> ${res.statusCode}: ${chunks}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function generatePassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '');
}

// สร้าง (หรืออัปเดต) Local User บน FortiGate แล้วเพิ่มเข้า Guest Group
async function createGuestUser(username) {
  const password = generatePassword();

  // 1) สร้าง/อัปเดต Local User
  try {
    await fgtRequest('POST', '/api/v2/cmdb/user/local', {
      name: username,
      type: 'password',
      passwd: password,
      status: 'enable'
    });
  } catch (e) {
    // ถ้ามี user นี้อยู่แล้ว (เคยลงทะเบียนซ้ำ) ให้ PUT อัปเดต password แทน
    await fgtRequest('PUT', `/api/v2/cmdb/user/local/${encodeURIComponent(username)}`, {
      passwd: password,
      status: 'enable'
    });
  }

  // 2) เพิ่มเข้า Guest Group (ignore error ถ้าเป็นสมาชิกอยู่แล้ว)
  try {
    await fgtRequest('POST', `/api/v2/cmdb/user/group/${encodeURIComponent(FGT_GROUP)}/member`, {
      name: username
    });
  } catch (e) {
    console.warn('[FortiGate] Add member warning:', e.message);
  }

  return { username, password };
}

module.exports = { createGuestUser };
