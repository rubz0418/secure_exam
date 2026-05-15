const express = require('express');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { scoreObjectiveQuestions } = require('../services/scoringService');
const { logActivity } = require('../services/activityService');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const params = [];
  let where = '';
  if (req.user.role === 'student') {
    where = 'WHERE s.student_id = ?';
    params.push(req.user.id);
  } else if (req.user.role === 'teacher') {
    where = 'WHERE e.created_by = ?';
    params.push(req.user.id);
  }
  const [rows] = await pool.query(
    `SELECT s.*, e.title exam_title, e.duration, u.name student_name
     FROM submissions s
     JOIN exams e ON e.id = s.exam_id
     JOIN users u ON u.id = s.student_id
     ${where}
     ORDER BY s.started_at DESC`,
    params
  );
  res.json(rows);
});

router.get('/:id', requireAuth, async (req, res) => {
  const [[submission]] = await pool.query(
    `SELECT s.*, e.title exam_title, e.created_by, u.name student_name
     FROM submissions s
     JOIN exams e ON e.id=s.exam_id
     JOIN users u ON u.id=s.student_id
     WHERE s.id = ?`,
    [req.params.id]
  );
  if (!submission) return res.status(404).json({ message: 'Submission not found' });
  if (req.user.role === 'student' && submission.student_id !== req.user.id) return res.status(403).json({ message: 'Forbidden' });
  if (req.user.role === 'teacher' && submission.created_by !== req.user.id) return res.status(403).json({ message: 'Forbidden' });

  const [answers] = await pool.query(
    `SELECT a.*, q.question_text, q.type, q.points
     FROM answers a
     JOIN questions q ON q.id = a.question_id
     WHERE a.submission_id = ?
     ORDER BY q.sort_order, q.id`,
    [req.params.id]
  );
  res.json({ ...submission, answers });
});

router.post('/start', requireAuth, requireRole('student'), async (req, res) => {
  const { examId } = req.body;
  const [[existing]] = await pool.query('SELECT * FROM submissions WHERE exam_id=? AND student_id=?', [examId, req.user.id]);
  if (existing && ['submitted', 'graded', 'timed_out'].includes(existing.status)) {
    return res.status(409).json({ message: 'You already finished this exam' });
  }
  const [result] = await pool.query(
    `INSERT INTO submissions (exam_id, student_id, status, started_at)
     VALUES (?, ?, 'in_progress', NOW())
     ON DUPLICATE KEY UPDATE status = IF(status IN ('submitted','graded','timed_out'), status, 'in_progress')`,
    [examId, req.user.id]
  );
  const [[row]] = await pool.query('SELECT * FROM submissions WHERE exam_id=? AND student_id=?', [examId, req.user.id]);
  await pool.query(
    `INSERT INTO monitoring_sessions (exam_id, student_id, status, last_seen)
     VALUES (?, ?, 'check_in', NOW())
     ON DUPLICATE KEY UPDATE status='check_in', last_seen=NOW()`,
    [examId, req.user.id]
  );
  await logActivity(req.user.id, 'start_exam', `Started exam ${examId}`);
  res.status(result.insertId ? 201 : 200).json(row);
});

router.post('/submit', requireAuth, requireRole('student'), upload.any(), async (req, res) => {
  const examId = Number(req.body.examId);
  const status = req.body.status === 'timed_out' ? 'timed_out' : 'submitted';
  const answers = JSON.parse(req.body.answers || '{}');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO submissions (exam_id, student_id, status, submitted_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE status=VALUES(status), submitted_at=NOW()`,
      [examId, req.user.id, status]
    );
    const [[submission]] = await connection.query('SELECT * FROM submissions WHERE exam_id=? AND student_id=?', [examId, req.user.id]);
    const fileMap = Object.fromEntries((req.files || []).map((file) => [file.fieldname.replace('file_', ''), `/uploads/${file.filename}`]));

    for (const [questionId, answer] of Object.entries(answers)) {
      await connection.query(
        `INSERT INTO answers (submission_id, question_id, answer_text, file_path)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE answer_text=VALUES(answer_text), file_path=VALUES(file_path)`,
        [submission.id, questionId, typeof answer === 'string' ? answer : JSON.stringify(answer), fileMap[questionId] || null]
      );
    }

    for (const [questionId, filePath] of Object.entries(fileMap)) {
      if (!answers[questionId]) {
        await connection.query(
          `INSERT INTO answers (submission_id, question_id, answer_text, file_path)
           VALUES (?, ?, '', ?)
           ON DUPLICATE KEY UPDATE file_path=VALUES(file_path)`,
          [submission.id, questionId, filePath]
        );
      }
    }

    const autoScore = await scoreObjectiveQuestions(connection, submission.id, examId);
    await connection.query('UPDATE submissions SET auto_score=?, score=?+manual_score WHERE id=?', [
      autoScore,
      autoScore,
      submission.id
    ]);
    await connection.query(
      `UPDATE monitoring_sessions SET status=?, camera_on=0, mic_on=0, last_seen=NOW()
       WHERE exam_id=? AND student_id=?`,
      [status, examId, req.user.id]
    );
    await connection.commit();
    req.app.get('io').to(`exam:${examId}`).emit('student_finished', { examId, studentId: req.user.id, status });
    await logActivity(req.user.id, status === 'timed_out' ? 'exam_timed_out' : 'submit_exam', `Exam ${examId}`);
    res.json({ ok: true, submissionId: submission.id, autoScore });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

router.put('/:id/grade', requireAuth, requireRole('admin', 'teacher'), async (req, res) => {
  const { answerGrades = {}, feedback = '' } = req.body;
  const connection = await pool.getConnection();
  try {
    const [[submissionOwner]] = await connection.query(
      `SELECT e.created_by
       FROM submissions s
       JOIN exams e ON e.id=s.exam_id
       WHERE s.id=?`,
      [req.params.id]
    );
    if (!submissionOwner) return res.status(404).json({ message: 'Submission not found' });
    if (req.user.role === 'teacher' && submissionOwner.created_by !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    await connection.beginTransaction();
    let manualTotal = 0;
    for (const [answerId, grade] of Object.entries(answerGrades)) {
      const [[row]] = await connection.query(
        `SELECT a.id, q.points FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.id=?`,
        [answerId]
      );
      if (!row) continue;
      const score = Number(grade.manualScore || 0);
      if (score > Number(row.points)) {
        await connection.rollback();
        return res.status(400).json({ message: "Inputted Above the Point's Range!" });
      }
      manualTotal += score;
      await connection.query('UPDATE answers SET manual_score=?, feedback=? WHERE id=?', [
        score,
        grade.feedback || '',
        answerId
      ]);
    }
    await connection.query(
      "UPDATE submissions SET manual_score=?, score=auto_score+?, feedback=?, status='graded' WHERE id=?",
      [manualTotal, manualTotal, feedback, req.params.id]
    );
    await connection.commit();
    await logActivity(req.user.id, 'grade_submission', `Submission ${req.params.id}`);
    res.json({ ok: true });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

module.exports = router;
