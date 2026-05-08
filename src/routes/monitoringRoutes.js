const express = require('express');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');

const router = express.Router();

router.post('/warnings', requireAuth, async (req, res) => {
  const { examId, type, details = '' } = req.body;
  await pool.query('INSERT INTO warnings (student_id, exam_id, type, details, timestamp) VALUES (?, ?, ?, ?, NOW())', [
    req.user.id,
    examId,
    type,
    details
  ]);
  req.app.get('io').to(`exam:${examId}`).emit('warning', { examId, studentId: req.user.id, name: req.user.name, type, details });
  await logActivity(req.user.id, 'warning', `${type} on exam ${examId}`);
  res.status(201).json({ ok: true });
});

router.get('/exam/:examId', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
  const [sessions] = await pool.query(
    `SELECT m.*, u.name, u.email,
      (SELECT COUNT(*) FROM warnings w WHERE w.exam_id=m.exam_id AND w.student_id=m.student_id) warning_count
     FROM monitoring_sessions m
     JOIN users u ON u.id=m.student_id
     WHERE m.exam_id=? AND m.hidden_by_teacher=0
     ORDER BY m.last_seen DESC`,
    [req.params.examId]
  );
  const [warnings] = await pool.query(
    `SELECT w.*, u.name FROM warnings w JOIN users u ON u.id=w.student_id
     WHERE w.exam_id=? ORDER BY w.timestamp DESC LIMIT 200`,
    [req.params.examId]
  );
  res.json({ sessions, warnings });
});

router.patch('/exam/:examId/student/:studentId/hide', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
  await pool.query('UPDATE monitoring_sessions SET hidden_by_teacher=1 WHERE exam_id=? AND student_id=?', [
    req.params.examId,
    req.params.studentId
  ]);
  res.json({ ok: true });
});

module.exports = router;
