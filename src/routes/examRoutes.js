const express = require('express');
const crypto = require('crypto');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logActivity } = require('../services/activityService');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  let sql = `
    SELECT e.*, u.name teacher_name,
      (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) question_count,
      (SELECT COUNT(*) FROM submissions s WHERE s.exam_id = e.id) submission_count
    FROM exams e
    JOIN users u ON u.id = e.created_by
  `;
  const params = [];
  if (req.user.role === 'teacher') {
    sql += ' WHERE e.created_by = ?';
    params.push(req.user.id);
  }
  sql += ' ORDER BY e.created_at DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
});

router.get('/access/:key', requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM exams
     WHERE is_published = 1 AND (access_code = ? OR direct_link_token = ?)
     LIMIT 1`,
    [req.params.key, req.params.key]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Exam not found or not published' });
  const exam = await loadExam(rows[0].id);
  res.json(exam);
});

router.get('/:id', requireAuth, async (req, res) => {
  const exam = await loadExam(req.params.id);
  if (!exam) return res.status(404).json({ message: 'Exam not found' });
  if (req.user.role === 'teacher' && exam.created_by !== req.user.id) return res.status(403).json({ message: 'Forbidden' });
  res.json(exam);
});

router.post('/', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
  try {
    validateExamRequest(req.body);
    const saved = await runTransactionWithRetry(async (connection) => {
      const accessCode = makeCode();
      const directLinkToken = crypto.randomBytes(24).toString('hex');
      const [result] = await connection.query(
        `INSERT INTO exams
         (title, description, duration, access_method, access_code, direct_link_token, created_by, scheduled_at,
          require_all_questions, enable_camera, enable_microphone, disable_copy_paste, screenshot_detection, phone_detection)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.body.title,
          req.body.description || '',
          Number(req.body.duration || 60),
          req.body.accessMethod || 'code',
          accessCode,
          directLinkToken,
          req.user.id,
          req.body.scheduledAt || null,
          bool(req.body.requireAllQuestions, true),
          bool(req.body.enableCamera),
          bool(req.body.enableMicrophone),
          bool(req.body.disableCopyPaste, true),
          bool(req.body.screenshotDetection, true),
          bool(req.body.phoneDetection, true)
        ]
      );
      await saveQuestions(connection, result.insertId, req.body.questions || []);
      return { id: result.insertId, title: req.body.title };
    });
    logActivity(req.user.id, 'create_exam', `Created exam ${saved.id}`).catch((error) => {
      console.error('Activity log failed:', error.message);
    });
    res.status(201).json({
      id: saved.id,
      title: saved.title,
      message: 'Exam saved'
    });
  } catch (error) {
    console.error('Create exam failed:', error.message);
    res.status(isConnectionError(error) ? 503 : 400).json({
      message: isConnectionError(error)
        ? 'Database connection unavailable. Check Aiven connection and try again.'
        : error.message || 'Unable to save exam'
    });
  }
});

router.put('/:id', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
  try {
    validateExamRequest(req.body);
    const [existing] = await pool.query('SELECT * FROM exams WHERE id = ?', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ message: 'Exam not found' });
    if (existing[0].created_by !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
    if (existing[0].is_published) return res.status(400).json({ message: 'Unpublish exam before editing' });

    await runTransactionWithRetry(async (connection) => {
      await connection.query(
        `UPDATE exams SET title=?, description=?, duration=?, access_method=?, scheduled_at=?,
         require_all_questions=?, enable_camera=?, enable_microphone=?, disable_copy_paste=?, screenshot_detection=?, phone_detection=?
         WHERE id=?`,
        [
          req.body.title,
          req.body.description || '',
          Number(req.body.duration || 60),
          req.body.accessMethod || 'code',
          req.body.scheduledAt || null,
          bool(req.body.requireAllQuestions, true),
          bool(req.body.enableCamera),
          bool(req.body.enableMicrophone),
          bool(req.body.disableCopyPaste, true),
          bool(req.body.screenshotDetection, true),
          bool(req.body.phoneDetection, true),
          req.params.id
        ]
      );
      await connection.query('DELETE FROM questions WHERE exam_id = ?', [req.params.id]);
      await saveQuestions(connection, req.params.id, req.body.questions || []);
    });
    logActivity(req.user.id, 'update_exam', `Updated exam ${req.params.id}`).catch((error) => {
      console.error('Activity log failed:', error.message);
    });
    res.json({
      id: Number(req.params.id),
      title: req.body.title,
      message: 'Exam updated'
    });
  } catch (error) {
    console.error('Update exam failed:', error.message);
    res.status(isConnectionError(error) ? 503 : 400).json({
      message: isConnectionError(error)
        ? 'Database connection unavailable. Check Aiven connection and try again.'
        : error.message || 'Unable to save exam'
    });
  }
});

router.patch('/:id/publish', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
  const [existing] = await pool.query('SELECT id, created_by FROM exams WHERE id = ?', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ message: 'Exam not found' });
  if (existing[0].created_by !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
  await pool.query('UPDATE exams SET is_published = ? WHERE id = ?', [Boolean(req.body.isPublished), req.params.id]);
  await logActivity(req.user.id, req.body.isPublished ? 'publish_exam' : 'unpublish_exam', `Exam ${req.params.id}`);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
  try {
    const [existing] = await pool.query('SELECT id, title, created_by FROM exams WHERE id = ?', [req.params.id]);
    const exam = existing[0];
    if (!exam) return res.status(404).json({ message: 'Exam not found' });
    if (exam.created_by !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });

    await pool.query('DELETE FROM chat WHERE exam_id = ?', [req.params.id]);
    await pool.query('DELETE FROM exams WHERE id = ?', [req.params.id]);
    logActivity(req.user.id, 'delete_exam', `Deleted exam ${req.params.id}: ${exam.title}`).catch((error) => {
      console.error('Activity log failed:', error.message);
    });
    res.json({ ok: true, message: 'Exam deleted' });
  } catch (error) {
    console.error('Delete exam failed:', error.message);
    res.status(isConnectionError(error) ? 503 : 400).json({
      message: isConnectionError(error)
        ? 'Database connection unavailable. Check Aiven connection and try again.'
        : error.message || 'Unable to delete exam'
    });
  }
});

async function saveQuestions(connection, examId, questions) {
  for (const [index, question] of questions.entries()) {
    const [qResult] = await connection.query(
      `INSERT INTO questions (exam_id, type, question_text, points, is_required, sort_order, correct_answer)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        examId,
        question.type,
        question.questionText,
        Number(question.points || 1),
        bool(question.isRequired, true),
        index,
        question.correctAnswer || null
      ]
    );
    for (const option of question.options || []) {
      await connection.query('INSERT INTO options (question_id, option_text, is_correct) VALUES (?, ?, ?)', [
        qResult.insertId,
        option.optionText,
        Boolean(option.isCorrect)
      ]);
    }
  }
}

async function loadExam(id) {
  const [exams] = await pool.query('SELECT e.*, u.name teacher_name FROM exams e JOIN users u ON u.id=e.created_by WHERE e.id = ?', [id]);
  if (!exams[0]) return null;
  const [questions] = await pool.query('SELECT * FROM questions WHERE exam_id = ? ORDER BY sort_order, id', [id]);
  const [options] = await pool.query(
    'SELECT o.* FROM options o JOIN questions q ON q.id = o.question_id WHERE q.exam_id = ? ORDER BY o.id',
    [id]
  );
  return {
    ...exams[0],
    questions: questions.map((question) => ({
      ...question,
      options: options.filter((option) => option.question_id === question.id)
    }))
  };
}

function makeCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function bool(value, fallback = false) {
  return value === undefined ? fallback : Boolean(value);
}

function isConnectionError(error) {
  return ['ETIMEDOUT', 'ENOTFOUND', 'ENETUNREACH', 'ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST'].includes(error.code);
}

function validateExamRequest(body) {
  const validTypes = ['mcq', 'dropdown', 'checkbox', 'short_answer', 'paragraph', 'file_upload', 'image_upload'];
  if (!String(body.title || '').trim()) throw new Error('Exam title is required');
  if (!Array.isArray(body.questions) || body.questions.length === 0) throw new Error('Add at least one question');
  body.questions.forEach((question, index) => {
    if (!validTypes.includes(question.type)) throw new Error(`Question ${index + 1} needs a valid answer type`);
    if (!String(question.questionText || '').trim()) throw new Error(`Question ${index + 1} needs question text`);
    if (['mcq', 'dropdown', 'checkbox'].includes(question.type)) {
      const options = Array.isArray(question.options) ? question.options.filter((option) => String(option.optionText || '').trim()) : [];
      if (options.length < 2) throw new Error(`Question ${index + 1} needs at least two options`);
      if (!options.some((option) => option.isCorrect)) throw new Error(`Question ${index + 1} needs at least one correct option`);
    }
  });
}

async function runTransactionWithRetry(task, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const result = await task(connection);
      await connection.commit();
      return result;
    } catch (error) {
      lastError = error;
      if (connection) await connection.rollback().catch(() => {});
      if (!isConnectionError(error) || attempt === attempts) throw error;
      await wait(700);
    } finally {
      if (connection) connection.release();
    }
  }
  throw lastError;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = router;
