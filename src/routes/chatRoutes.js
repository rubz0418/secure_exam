const express = require('express');
const { pool } = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/exam/:examId/user/:userId', requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT c.*, s.name sender_name, r.name receiver_name
     FROM chat c
     JOIN users s ON s.id=c.sender_id
     JOIN users r ON r.id=c.receiver_id
     WHERE c.exam_id=? AND ((c.sender_id=? AND c.receiver_id=?) OR (c.sender_id=? AND c.receiver_id=?))
     ORDER BY c.created_at ASC`,
    [req.params.examId, req.user.id, req.params.userId, req.params.userId, req.user.id]
  );
  res.json(rows);
});

module.exports = router;
