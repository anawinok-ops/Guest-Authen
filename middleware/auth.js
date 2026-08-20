// middleware/auth.js

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  // API request
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  // Browser request
  return res.redirect('/admin/login');
}

module.exports = { requireAdmin };
