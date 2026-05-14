require('dotenv').config();

const bcrypt = require('bcryptjs');
const { pool } = require('./config/db');

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(160) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      role ENUM('admin','teacher','student') NOT NULL DEFAULT 'student',
      status ENUM('active','suspended') NOT NULL DEFAULT 'active',
      theme VARCHAR(40) NOT NULL DEFAULT 'default',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS exams (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(180) NOT NULL,
      description TEXT,
      duration INT NOT NULL,
      access_method ENUM('code','link') NOT NULL DEFAULT 'code',
      access_code VARCHAR(20) NOT NULL UNIQUE,
      direct_link_token VARCHAR(80) NOT NULL UNIQUE,
      created_by INT NOT NULL,
      is_published BOOLEAN NOT NULL DEFAULT FALSE,
      scheduled_at DATETIME NULL,
      require_all_questions BOOLEAN NOT NULL DEFAULT TRUE,
      enable_camera BOOLEAN NOT NULL DEFAULT FALSE,
      enable_microphone BOOLEAN NOT NULL DEFAULT FALSE,
      disable_copy_paste BOOLEAN NOT NULL DEFAULT TRUE,
      screenshot_detection BOOLEAN NOT NULL DEFAULT TRUE,
      phone_detection BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS questions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      exam_id INT NOT NULL,
      type ENUM('mcq','dropdown','checkbox','short_answer','paragraph','file_upload','image_upload') NOT NULL,
      question_text TEXT NOT NULL,
      points DECIMAL(8,2) NOT NULL DEFAULT 1,
      is_required BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INT NOT NULL DEFAULT 0,
      correct_answer TEXT NULL,
      FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS options (
      id INT AUTO_INCREMENT PRIMARY KEY,
      question_id INT NOT NULL,
      option_text TEXT NOT NULL,
      is_correct BOOLEAN NOT NULL DEFAULT FALSE,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      exam_id INT NOT NULL,
      student_id INT NOT NULL,
      auto_score DECIMAL(8,2) NOT NULL DEFAULT 0,
      manual_score DECIMAL(8,2) NOT NULL DEFAULT 0,
      score DECIMAL(8,2) NOT NULL DEFAULT 0,
      status ENUM('in_progress','submitted','graded','timed_out') NOT NULL DEFAULT 'in_progress',
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      submitted_at DATETIME NULL,
      feedback TEXT NULL,
      UNIQUE KEY unique_exam_student (exam_id, student_id),
      FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS answers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      submission_id INT NOT NULL,
      question_id INT NOT NULL,
      answer_text LONGTEXT,
      file_path VARCHAR(255) NULL,
      auto_score DECIMAL(8,2) NOT NULL DEFAULT 0,
      manual_score DECIMAL(8,2) NOT NULL DEFAULT 0,
      feedback TEXT NULL,
      UNIQUE KEY unique_submission_question (submission_id, question_id),
      FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS warnings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      student_id INT NOT NULL,
      exam_id INT NOT NULL,
      type VARCHAR(80) NOT NULL,
      details TEXT NULL,
      timestamp DATETIME NOT NULL,
      FOREIGN KEY (student_id) REFERENCES users(id),
      FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat (
      id INT AUTO_INCREMENT PRIMARY KEY,
      exam_id INT NULL,
      sender_id INT NOT NULL,
      receiver_id INT NOT NULL,
      message LONGTEXT NOT NULL,
      type ENUM('text','voice') NOT NULL DEFAULT 'text',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (receiver_id) REFERENCES users(id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitoring_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      exam_id INT NOT NULL,
      student_id INT NOT NULL,
      camera_on BOOLEAN NOT NULL DEFAULT FALSE,
      mic_on BOOLEAN NOT NULL DEFAULT FALSE,
      status ENUM('check_in','active','submitted','timed_out','offline') NOT NULL DEFAULT 'check_in',
      last_seen DATETIME NOT NULL,
      hidden_by_teacher BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE KEY unique_monitor_session (exam_id, student_id),
      FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      action VARCHAR(100) NOT NULL,
      details TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const [admins] = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (admins.length === 0) {
    const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@secureexam.local';
    const adminPassword = process.env.SEED_ADMIN_PASSWORD || `Admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = await bcrypt.hash(adminPassword, 10);
    await pool.query(
      "INSERT INTO users (name, email, password, role, status) VALUES (?, ?, ?, 'admin', 'active')",
      ['System Admin', adminEmail, password]
    );
    console.log(`Seeded admin account: ${adminEmail}`);
    if (!process.env.SEED_ADMIN_PASSWORD) {
      console.log(`Generated one-time admin password: ${adminPassword}`);
    }
  }

  console.log('SecureExam database is ready.');
  await pool.end();
}

init().catch((error) => {
  console.error(error);
  process.exit(1);
});
