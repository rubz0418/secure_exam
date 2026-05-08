const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { name, email, password, role = 'student' } = req.body;
  if (!name || !email || !password) return res.status(400).json({ message: 'Name, email, and password are required' });
  if (!['admin', 'teacher', 'student'].includes(role)) return res.status(400).json({ message: 'Invalid role' });

  const hash = await bcrypt.hash(password, 10);
  try {
    const [result] = await pool.query(
      "INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, ?, 'active')",
      [name, email, hash, role]
    );
    await logActivity(result.insertId, 'register', `Registered as ${role}`);
    res.status(201).json({ id: result.insertId, name, email, role });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Email already exists' });
    console.error(error);
    return res.status(500).json({ message: 'Registration failed. Please try again.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];
    if (!user || user.status !== 'active') return res.status(401).json({ message: 'Invalid credentials or suspended account' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role, theme: user.theme },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    await logActivity(user.id, 'login', 'User logged in');
    res.json({ token, user: publicUser(user) });
  } catch (error) {
    console.error('Login failed:', error.message);
    res.status(503).json({ message: 'Database connection unavailable. Check Aiven connection and try again.' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT id, name, email, role, status, theme, created_at FROM users WHERE id = ?', [req.user.id]);
  res.json(rows[0]);
});

router.put('/profile', requireAuth, async (req, res) => {
  const { name, theme } = req.body;
  await pool.query('UPDATE users SET name = COALESCE(?, name), theme = COALESCE(?, theme) WHERE id = ?', [
    name || null,
    theme || null,
    req.user.id
  ]);
  await logActivity(req.user.id, 'profile_update', 'Updated profile settings');
  const [rows] = await pool.query('SELECT id, name, email, role, status, theme FROM users WHERE id = ?', [req.user.id]);
  res.json(rows[0]);
});

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    theme: user.theme
  };
}

module.exports = router;
