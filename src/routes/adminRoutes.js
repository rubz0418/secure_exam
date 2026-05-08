const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/stats', async (_req, res) => {
  const [[users]] = await pool.query(`
    SELECT COUNT(*) totalUsers,
      SUM(role='teacher') teachers,
      SUM(role='student') students,
      SUM(role='admin') admins
    FROM users
  `);
  const [[exams]] = await pool.query('SELECT COUNT(*) totalExams, SUM(is_published=1) publishedExams FROM exams');
  const [[submissions]] = await pool.query('SELECT COUNT(*) totalSubmissions FROM submissions');
  const [userGrowth] = await pool.query(`
    SELECT DATE(created_at) label, COUNT(*) value FROM users GROUP BY DATE(created_at) ORDER BY label LIMIT 14
  `);
  const [examActivity] = await pool.query(`
    SELECT DATE(created_at) label, COUNT(*) value FROM exams GROUP BY DATE(created_at) ORDER BY label LIMIT 14
  `);
  res.json({ ...users, ...exams, ...submissions, userGrowth, examActivity });
});

router.get('/users', async (_req, res) => {
  const [rows] = await pool.query('SELECT id, name, email, role, status, theme, created_at FROM users ORDER BY created_at DESC');
  res.json(rows);
});

router.post('/users', async (req, res) => {
  const { name, email, password, role, status = 'active' } = req.body;
  const hash = await bcrypt.hash(password || 'password123', 10);
  const [result] = await pool.query(
    'INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, ?, ?)',
    [name, email, hash, role, status]
  );
  await logActivity(req.user.id, 'admin_create_user', `Created user ${email}`);
  res.status(201).json({ id: result.insertId });
});

router.put('/users/:id', async (req, res) => {
  const { name, email, role, status, password } = req.body;
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET name=?, email=?, role=?, status=?, password=? WHERE id=?', [
      name,
      email,
      role,
      status,
      hash,
      req.params.id
    ]);
  } else {
    await pool.query('UPDATE users SET name=?, email=?, role=?, status=? WHERE id=?', [
      name,
      email,
      role,
      status,
      req.params.id
    ]);
  }
  await logActivity(req.user.id, 'admin_update_user', `Updated user ${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/users/:id', async (req, res) => {
  await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
  await logActivity(req.user.id, 'admin_delete_user', `Deleted user ${req.params.id}`);
  res.json({ ok: true });
});

router.get('/logs', async (_req, res) => {
  const [rows] = await pool.query(`
    SELECT l.*, u.name, u.email, u.role
    FROM activity_logs l
    LEFT JOIN users u ON u.id = l.user_id
    ORDER BY l.created_at DESC
    LIMIT 300
  `);
  res.json(rows);
});

module.exports = router;
