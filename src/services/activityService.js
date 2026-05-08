const { pool } = require('../config/db');

async function logActivity(userId, action, details = '') {
  await pool.query(
    'INSERT INTO activity_logs (user_id, action, details, created_at) VALUES (?, ?, ?, NOW())',
    [userId || null, action, details]
  );
}

module.exports = { logActivity };
