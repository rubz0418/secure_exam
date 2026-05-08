require('dotenv').config();

process.on('unhandledRejection', (error) => {
  console.error('Unhandled async error:', error.message || error);
});

process.on('uncaughtException', (error) => {
  console.error('Unexpected server error:', error.message || error);
});

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { pool } = require('./src/config/db');
const { verifyToken } = require('./src/middleware/auth');
const authRoutes = require('./src/routes/authRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const examRoutes = require('./src/routes/examRoutes');
const submissionRoutes = require('./src/routes/submissionRoutes');
const monitoringRoutes = require('./src/routes/monitoringRoutes');
const chatRoutes = require('./src/routes/chatRoutes');
const { logActivity } = require('./src/services/activityService');

const app = express();
const server = http.createServer(app);
const socketErrorLogTimes = new Map();
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.set('io', io);
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, process.env.UPLOAD_DIR || 'public/uploads')));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/exams', examRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/monitoring', monitoringRoutes);
app.use('/api/chat', chatRoutes);

app.get('/api/health', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.json({ ok: rows[0].ok === 1, app: 'SecureExam', database: 'connected' });
  } catch (error) {
    console.error('Health check database failed:', error.message);
    res.status(503).json({ ok: false, app: 'SecureExam', database: 'unavailable', message: error.code || error.message });
  }
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Missing token'));
    socket.user = verifyToken(token);
    next();
  } catch (error) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.user.id}`);

  socket.on('join_exam', async ({ examId }) => {
    try {
      if (!examId) return;
      socket.join(`exam:${examId}`);
      socket.join(`user:${socket.user.id}`);
      await logActivity(socket.user.id, 'socket_join_exam', `Joined exam room ${examId}`);
    } catch (error) {
      handleSocketError(socket, error);
    }
  });

  socket.on('monitor_update', async (payload = {}) => {
    try {
      const { examId, cameraOn = false, micOn = false, status = 'active' } = payload;
      if (!examId) return;
      await pool.query(
        `INSERT INTO monitoring_sessions (exam_id, student_id, camera_on, mic_on, status, last_seen)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
          camera_on=IF(status IN ('submitted','timed_out'), 0, VALUES(camera_on)),
          mic_on=IF(status IN ('submitted','timed_out'), 0, VALUES(mic_on)),
          status=IF(status IN ('submitted','timed_out'), status, VALUES(status)),
          last_seen=NOW()`,
        [examId, socket.user.id, cameraOn, micOn, status]
      );
      io.to(`exam:${examId}`).emit('monitor_update', {
        examId,
        studentId: socket.user.id,
        name: socket.user.name,
        cameraOn,
        micOn,
        status,
        lastSeen: new Date().toISOString()
      });
    } catch (error) {
      handleSocketError(socket, error);
    }
  });

  socket.on('warning', async (payload = {}) => {
    try {
      const { examId, type, details = '' } = payload;
      if (!examId || !type) return;
      await pool.query(
        'INSERT INTO warnings (student_id, exam_id, type, details, timestamp) VALUES (?, ?, ?, ?, NOW())',
        [socket.user.id, examId, type, details]
      );
      await logActivity(socket.user.id, 'warning', `${type} on exam ${examId}`);
      io.to(`exam:${examId}`).emit('warning', {
        examId,
        studentId: socket.user.id,
        name: socket.user.name,
        type,
        details,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      handleSocketError(socket, error);
    }
  });

  socket.on('camera_frame', (payload = {}) => {
    const { examId, frame } = payload;
    if (!examId || !frame || socket.user.role !== 'student') return;
    io.to(`exam:${examId}`).emit('camera_frame', {
      examId,
      studentId: socket.user.id,
      frame,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('chat_message', async (payload = {}) => {
    try {
      const { examId, receiverId, message, type = 'text' } = payload;
      if (!examId || !receiverId || !message) return;
      const [result] = await pool.query(
        'INSERT INTO chat (exam_id, sender_id, receiver_id, message, type, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [examId, socket.user.id, receiverId, message, type]
      );
      const row = {
        id: result.insertId,
        examId,
        senderId: socket.user.id,
        senderName: socket.user.name,
        receiverId,
        message,
        type,
        createdAt: new Date().toISOString()
      };
      io.to(`user:${receiverId}`).emit('chat_message', row);
      socket.emit('chat_message', row);
    } catch (error) {
      handleSocketError(socket, error);
    }
  });
});

function handleSocketError(socket, error) {
  const key = `${error.code || 'SOCKET'}:${error.hostname || error.message}`;
  const now = Date.now();
  const lastLogged = socketErrorLogTimes.get(key) || 0;
  if (now - lastLogged > 30000) {
    console.error('Socket event failed:', error.message);
    socketErrorLogTimes.set(key, now);
  }
  socket.emit('server_notice', {
    message: 'Database connection is temporarily unavailable. Please check internet or Aiven DNS settings.'
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ message: error.message || 'Server error' });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`SecureExam running on http://localhost:${port}`);
});
