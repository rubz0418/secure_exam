async function scoreObjectiveQuestions(connection, submissionId, examId) {
  const [questions] = await connection.query(
    `SELECT id, type, points, correct_answer
     FROM questions
     WHERE exam_id = ? AND type IN ('mcq', 'dropdown', 'checkbox', 'short_answer')`,
    [examId]
  );

  let total = 0;
  for (const question of questions) {
    const [answers] = await connection.query(
      'SELECT answer_text FROM answers WHERE submission_id = ? AND question_id = ?',
      [submissionId, question.id]
    );
    const answerText = answers[0]?.answer_text || '';
    const selected = safeJson(answerText);

    let isCorrect = false;
    if (question.type === 'short_answer') {
      isCorrect = normalizeAnswer(answerText) === normalizeAnswer(question.correct_answer || '');
    } else {
      const [correctRows] = await connection.query(
        'SELECT option_text FROM options WHERE question_id = ? AND is_correct = 1 ORDER BY id',
        [question.id]
      );
      const correct = correctRows.map((row) => row.option_text);
      isCorrect = question.type === 'checkbox'
        ? sameSet(Array.isArray(selected) ? selected : [answerText], correct)
        : correct.includes(Array.isArray(selected) ? selected[0] : answerText);
    }

    const earned = isCorrect ? Number(question.points || 0) : 0;
    await connection.query('UPDATE answers SET auto_score = ? WHERE submission_id = ? AND question_id = ?', [
      earned,
      submissionId,
      question.id
    ]);
    total += earned;
  }
  return total;
}

function normalizeAnswer(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return value;
  }
}

function sameSet(a, b) {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

module.exports = { scoreObjectiveQuestions };
